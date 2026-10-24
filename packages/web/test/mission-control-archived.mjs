// Hermetic unit tests for the pure derivations behind the god-eye fleet feeds (src/lib/fleet.ts) — the
// fully-archived-project tier, and, since card ff6123de, the three rules Mission Control now SHARES with
// the Atlas Workspace node's Replay tab (`fleetProjectNames`, `replayRoots`, `GLOBAL_ACTIVITY_CAP`).
//
// MC builds its fleet from the RUNNING session set, so a project whose sessions have all
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
import { readFileSync } from "node:fs";
import {
  archivedOnlyProjects, ARCHIVED_ONLY_CAP, fleetProjectNames, replayRoots, GLOBAL_ACTIVITY_CAP,
  pulseExitedManagers, PULSE_EXITED_MANAGER_CAP, PULSE_EXITED_REFETCH_MS,
} from "../src/lib/fleet.ts";

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

// ── The derivations Mission Control now SHARES with the Atlas Workspace Replay tab (card ff6123de) ────
// Both surfaces render the same inactive tier and the same replay picker. The rules live in lib/fleet.ts
// precisely so there is one copy; these checks are what makes a silent edit to either one visible.

check("fleetProjectNames is the LIVE population the inactive tier is the complement of", () => {
  const live = [
    { ...sess("Loom"), role: "manager", processState: "live" },
    { ...sess("Loom"), role: "worker", processState: "live" },
    { ...sess("FireStudio"), role: "manager", processState: "live" },
  ];
  assert.deepEqual(fleetProjectNames(live), ["Loom", "FireStudio"], "feed order, de-duplicated");
  // ⭐ THE DISCRIMINATING CASE, and the reason this is a named function rather than three inline lines:
  // a project whose only live row is a companion/setup session has no WAVE running, so it must stay OUT
  // of the live population and therefore read as inactive — Mission Control's long-standing behaviour.
  const companionOnly = [{ ...sess("Chatty"), role: "companion", processState: "live" }];
  assert.deepEqual(fleetProjectNames(companionOnly), [], "a non-manager/worker row is not a live wave");
  // And the two halves compose: that project IS surfaced as inactive once it has archived rows.
  const names = archivedOnlyProjects(fleetProjectNames(companionOnly), [sess("Chatty")]).map((p) => p.name);
  assert.deepEqual(names, ["Chatty"]);
});

check("replayRoots puts LIVE managers first, then archived ones, de-duped with the live row winning", () => {
  const mgr = (id, processState, lastActivity) =>
    ({ id, projectId: "p", projectName: "P", role: "manager", processState, lastActivity });
  const live = [
    mgr("exited-recent", "exited", "2026-06-03T00:00:00.000Z"),
    mgr("live-old", "live", "2026-06-01T00:00:00.000Z"),
    mgr("live-new", "live", "2026-06-02T00:00:00.000Z"),
  ];
  const archived = [mgr("arch-a", "exited", "2026-05-02T00:00:00.000Z"), mgr("arch-b", "exited", "2026-05-01T00:00:00.000Z")];
  assert.deepEqual(replayRoots(live, archived).map((m) => m.id),
    ["live-new", "live-old", "exited-recent", "arch-a", "arch-b"],
    "liveness outranks recency, recency breaks ties, and the archived feed's own order is preserved");
  // The dedupe, and its direction: a manager in BOTH feeds appears ONCE, as its LIVE row — the archived
  // copy is a stale snapshot of the same session and would render a second, wrong-state option.
  const both = replayRoots([mgr("m1", "live", "2026-06-01T00:00:00.000Z")], [mgr("m1", "exited", "2026-05-01T00:00:00.000Z")]);
  assert.equal(both.length, 1, "a manager in both feeds is offered once");
  assert.equal(both[0].processState, "live", "and the LIVE row is the one that survives");
  // Neither input is mutated — both arrive as react-query cache arrays, shared with every other reader.
  assert.deepEqual(live.map((m) => m.id), ["exited-recent", "live-old", "live-new"], "the live input is not sorted in place");
});

check("GLOBAL_ACTIVITY_CAP is ONE number, and both cross-project feeds read it instead of a literal", () => {
  assert.equal(GLOBAL_ACTIVITY_CAP, 100, "the cross-project activity feed renders 100 rows");
  // The anti-drift half, and the whole point of the constant: the two surfaces that render this feed must
  // REFERENCE it. A literal in either file is the 40-vs-100 split this card closed, reopening itself.
  for (const rel of ["../src/pages/MissionControl.tsx", "../src/pages/WorkspaceHome.tsx"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(src.includes("slice(0, GLOBAL_ACTIVITY_CAP)"),
      `${rel} must slice its cross-project activity feed with GLOBAL_ACTIVITY_CAP, not a literal`);
    assert.ok(!/slice\(0,\s*(?:40|100)\)/.test(src),
      `${rel} still caps a feed with a hardcoded 40/100 — that is the drift this constant exists to stop`);
  }
  // POSITIVE CONTROL on that second, ABSENCE-shaped assertion: the pattern must be shown capable of
  // matching, or two zero-hits prove nothing. The project-scoped pulse keeps its own literal by design.
  const projectHome = readFileSync(new URL("../src/pages/ProjectHome.tsx", import.meta.url), "utf8");
  assert.ok(/slice\(0,\s*40\)/.test(projectHome),
    "positive control: the hardcoded-cap pattern matches nothing anywhere, so the absences above are vacuous");
});

// ── The Pulse band's EXITED manager tier (card ef86b089) ──────────────────────────────────────────────
// Card 5afd71bd left one measured gap when it retired Mission Control: the band fanned out over LIVE
// managers only, so an exited-but-unarchived manager's events were reachable nowhere in Atlas. These
// assert the derivation that closes it AND the two numbers that keep its cost flat in N.

const pulseMgr = (id, processState, lastActivity, role = "manager") =>
  ({ id, projectId: "p", projectName: "P", role, processState, lastActivity });

check("pulseExitedManagers is the LIVE set's complement — so live ∪ it is Mission Control's own set", () => {
  const sessions = [
    pulseMgr("live", "live", "2026-06-05T00:00:00.000Z"),
    pulseMgr("starting", "starting", "2026-06-04T00:00:00.000Z"),
    pulseMgr("exited", "exited", "2026-06-03T00:00:00.000Z"),
    pulseMgr("none", "none", "2026-06-02T00:00:00.000Z"),
    pulseMgr("worker", "exited", "2026-06-01T00:00:00.000Z", "worker"),
    pulseMgr("companion", "exited", "2026-05-31T00:00:00.000Z", "assistant"),
  ];
  const exited = pulseExitedManagers(sessions);
  assert.deepEqual(exited.map((m) => m.id), ["exited", "none"],
    "the tier is every NON-live manager: `starting` is live (isLiveSession), a worker is not a manager");
  // The parity claim itself, asserted rather than described: the live tier the band already had, plus
  // this one, is exactly every manager in the non-archived list — which is what Mission Control read.
  const liveTier = sessions.filter((s) => s.role === "manager" && (s.processState === "live" || s.processState === "starting"));
  assert.deepEqual(
    [...liveTier, ...exited].map((m) => m.id).sort(),
    sessions.filter((s) => s.role === "manager").map((m) => m.id).sort(),
    "live ∪ exited must leave no manager unread, or the retired page is still reachable in a way Atlas is not");
  // A companion can never reach this tier, which is why the derivation carries no companion predicate.
  assert.ok(!exited.some((m) => m.role === "assistant"), "a companion's role is `assistant`, never `manager`");
});

check("pulseExitedManagers is CAPPED, most-recently-active first, and mutates nothing", () => {
  // Deliberately out of order on input: the cap only bounds cost usefully if it keeps the FRESHEST rows.
  const sessions = [
    pulseMgr("m-oldest", "exited", "2026-01-01T00:00:00.000Z"),
    pulseMgr("m-newest", "exited", "2026-06-01T00:00:00.000Z"),
    pulseMgr("m-middle", "exited", "2026-03-01T00:00:00.000Z"),
  ];
  assert.deepEqual(pulseExitedManagers(sessions, 2).map((m) => m.id), ["m-newest", "m-middle"],
    "the cap keeps the most recently active, not the input's own order");
  assert.deepEqual(sessions.map((m) => m.id), ["m-oldest", "m-newest", "m-middle"],
    "the input is a shared react-query cache array and must not be sorted in place");
  assert.equal(pulseExitedManagers(sessions, 0).length, 0, "a zero cap reads nothing");
  // The real cap is what bounds the request count: 20 exited managers can only ever cost CAP polls.
  assert.equal(pulseExitedManagers(Array.from({ length: 20 },
    (_, i) => pulseMgr(`m${i}`, "exited", `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`))).length,
    PULSE_EXITED_MANAGER_CAP,
    "the default cap must bound the tier regardless of how many exited managers a workspace accumulated");
});

check("the exited tier polls far more slowly than the live tier, and WorkspaceHome reads both constants", () => {
  assert.equal(PULSE_EXITED_MANAGER_CAP, 8);
  assert.equal(PULSE_EXITED_REFETCH_MS, 60_000);
  // The whole bound, stated as arithmetic rather than prose: the tier's worst case in requests/minute
  // must stay under ONE live manager's, whatever N is. Live is 3000ms ⇒ 20/min.
  const exitedPerMinute = PULSE_EXITED_MANAGER_CAP * (60_000 / PULSE_EXITED_REFETCH_MS);
  assert.ok(exitedPerMinute <= 60_000 / 3000,
    `the exited tier costs ${exitedPerMinute} req/min at its cap — more than the single live manager it must stay under`);
  // The anti-drift half: WorkspaceHome must REFERENCE the slow interval, never re-type it. A second
  // `refetchInterval: 3000` in that file would be the naive widening this card exists to avoid.
  const src = readFileSync(new URL("../src/pages/WorkspaceHome.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("pulseExitedManagers("),
    "WorkspaceHome no longer reads the exited tier — the 5afd71bd gap is reopened");
  assert.ok(src.includes("refetchInterval: PULSE_EXITED_REFETCH_MS"),
    "WorkspaceHome must poll the exited tier through the shared constant, not a literal of its own");
  assert.equal((src.match(/refetchInterval:\s*3000/g) ?? []).length, 1,
    "exactly one 3s pulse fan-out may exist in WorkspaceHome — a second is the unbounded widening");
  // POSITIVE CONTROL on that last count: the pattern must be shown capable of matching the file it is
  // asserted against, so a renamed option can never make the count pass by matching nothing.
  assert.ok(/refetchInterval:\s*\d+/.test(src),
    "positive control: the refetchInterval pattern matches nothing in WorkspaceHome, so the count above is vacuous");
});

console.log(`\n${pass} passed`);
