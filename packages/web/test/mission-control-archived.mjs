// Hermetic unit test for Mission Control's fully-archived-project tier (src/lib/fleet.ts › archivedOnlyProjects
// + ARCHIVED_ONLY_CAP). MC builds its fleet from the RUNNING session set, so a project whose sessions have all
// exited (auto-archived) would drop off the god-eye. This asserts the pure derivation behind the muted cards:
//  - a project present ONLY in the archived set yields an archived-only entry (→ a muted card on MC);
//  - a project that still has ANY live session is EXCLUDED (it stays in the live grid, which MC renders FIRST,
//    so live projects always rank ahead of archived-only ones);
//  - the derivation is O(n) via a live-name Set (no per-archived-row scan of the live list);
//  - the rendered count is CAPPED by ARCHIVED_ONLY_CAP so a deep archive can't crowd the active fleet;
//  - archived-only projects order freshest-finished-wave first.
//
// Like fleet.mjs, this imports the TS source directly via Node type stripping — no daemon, no React. Run with:
//   node --experimental-strip-types packages/web/test/mission-control-archived.mjs
import assert from "node:assert/strict";
import { archivedOnlyProjects, ARCHIVED_ONLY_CAP } from "../src/lib/fleet.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// Minimal archived-session factory — only the fields archivedOnlyProjects reads (projectName + projectId +
// lastActivity). projectId defaults to the name (the reserved-exclusion join key; the existing name-only
// cases pass an empty reserved set, so this default keeps them byte-for-byte unchanged).
let seq = 0;
const sess = (projectName, lastActivity = "2026-01-01T00:00:00.000Z", projectId = projectName) =>
  ({ id: `sess-${++seq}`, projectId, projectName, lastActivity, role: "worker", processState: "exited" });

// ── Derivation: only-archived → surfaced; has-any-live → excluded ─────────────────────────────────────

check("a project present ONLY in the archived set yields an archived-only entry", () => {
  const live = ["Loom"]; // Loom has live sessions
  const archived = [sess("FireStudio"), sess("FireStudio"), sess("Loom")]; // FireStudio fully archived
  const result = archivedOnlyProjects(live, archived);
  assert.equal(result.length, 1, "exactly one archived-only project");
  assert.equal(result[0].name, "FireStudio");
  assert.equal(result[0].archived.length, 2, "carries only that project's archived rows");
});

check("a project with ANY live session is EXCLUDED — it stays in the live grid, ranked first", () => {
  // Loom appears in BOTH sets (some sessions still live). It must NOT show as an archived-only card, since
  // MC renders it in the live grid ABOVE the archived tier — live always ranks ahead of archived-only.
  const live = ["Loom"];
  const archived = [sess("Loom"), sess("Loom")]; // Loom's exited sessions — but it's still live
  const result = archivedOnlyProjects(live, archived);
  assert.deepEqual(result, [], "no archived-only card for a still-live project");
});

check("an empty archive yields no archived-only projects", () => {
  assert.deepEqual(archivedOnlyProjects(["Loom"], []), []);
  assert.deepEqual(archivedOnlyProjects([], []), []);
});

// ── Reserved/system homes are excluded from the inactive set ──────────────────────────────────────────
// The reserved "Loom Platform" / "Platform" homes appear in the archive with zero live sessions, so they'd
// leak into MC's inactive strip. They're hidden from every other project surface (picker, header selector),
// so they must never read as an "inactive" project either. archivedOnlyProjects excludes them by projectId
// (the archived-session wire shape carries NO structural `reserved` flag — that lives on Project, not
// Session — so the caller passes the reserved-home ids it discovers via platformHome/setupHome).

check("reserved/system homes (by project id) are excluded from the inactive set", () => {
  const archived = [
    sess("FireStudio", "2026-06-01T00:00:00.000Z", "proj-fire"),      // ordinary → inactive card
    sess("Loom Platform", "2026-06-02T00:00:00.000Z", "proj-platform"), // reserved dev home → excluded
    sess("Platform", "2026-06-03T00:00:00.000Z", "proj-setup"),         // reserved shipping home → excluded
  ];
  const reserved = new Set(["proj-platform", "proj-setup"]);
  const names = archivedOnlyProjects([], archived, reserved).map((p) => p.name);
  assert.deepEqual(names, ["FireStudio"], "only the ordinary archived-only project survives; both reserved homes are filtered");
});

check("a reserved home with MULTIPLE archived sessions is still fully excluded", () => {
  const archived = [
    sess("Loom Platform", "2026-06-01T00:00:00.000Z", "proj-platform"),
    sess("Loom Platform", "2026-06-02T00:00:00.000Z", "proj-platform"),
    sess("RealProject", "2026-05-01T00:00:00.000Z", "proj-real"),
  ];
  const result = archivedOnlyProjects([], archived, new Set(["proj-platform"]));
  assert.deepEqual(result.map((p) => p.name), ["RealProject"], "no reserved-home card even with several exited sessions");
});

check("no reserved ids ⇒ nothing is filtered (backward compatible, default arg)", () => {
  const archived = [sess("A", "2026-01-01T00:00:00.000Z", "a"), sess("B", "2026-01-02T00:00:00.000Z", "b")];
  assert.equal(archivedOnlyProjects([], archived).length, 2, "omitted reservedProjectIds behaves as before");
  assert.equal(archivedOnlyProjects([], archived, new Set()).length, 2, "an empty reserved set filters nothing");
});

// ── Ordering: freshest finished wave first ────────────────────────────────────────────────────────────

check("archived-only projects order by most-recent archived activity, freshest first", () => {
  const archived = [
    sess("Old", "2026-01-01T00:00:00.000Z"),
    sess("Fresh", "2026-06-01T00:00:00.000Z"),
    sess("Mid", "2026-03-01T00:00:00.000Z"),
  ];
  const names = archivedOnlyProjects([], archived).map((p) => p.name);
  assert.deepEqual(names, ["Fresh", "Mid", "Old"]);
});

// ── The cap: a deep archive can't crowd the active fleet ──────────────────────────────────────────────

check("ARCHIVED_ONLY_CAP is a small, sane bound and caps the rendered card count", () => {
  assert.ok(ARCHIVED_ONLY_CAP >= 3 && ARCHIVED_ONLY_CAP <= 8, "the cap is a small fixed number");
  // 10 distinct fully-archived projects → the strip renders at most ARCHIVED_ONLY_CAP cards (the affordance
  // still reports the true total via result.length; the render slice is what MC caps).
  const archived = Array.from({ length: 10 }, (_, i) => sess(`Proj${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
  const result = archivedOnlyProjects([], archived);
  assert.equal(result.length, 10, "derivation returns every archived-only project (the true total)");
  const rendered = result.slice(0, ARCHIVED_ONLY_CAP);
  assert.equal(rendered.length, ARCHIVED_ONLY_CAP, "MC renders at most ARCHIVED_ONLY_CAP muted cards");
  assert.ok(rendered.length < result.length, "the cap actually holds back the deep archive");
});

console.log(`\n${pass} passed`);
