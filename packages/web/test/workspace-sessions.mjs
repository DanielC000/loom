// Hermetic unit test for the Atlas Workspace Sessions card's derivations — src/lib/workspaceSessions.ts,
// card 9b6be377 (the owner's Atlas feedback: `"Workspace": Add "Sessions" card with all running session
// terminals.`). No daemon, no browser: it imports the real functions and asserts on plain objects, so it
// cannot drift from a copy of their rules.
//
// Record: docs/decisions/9b6be377-atlas-workspace-sessions-card.md
//
// Run it with: node --experimental-strip-types packages/web/test/workspace-sessions.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// workspaceSessions.ts has REAL runtime imports of ./atlasHome (isLiveSession) and ./sessions
// (byManagerThenCreated, isCompanionSession), written extensionless in the bundler style the app
// uses, which Node's own resolver cannot follow. `_tsxLoaderHook.mjs` exists for exactly that.
// Registering it means the import below must be DYNAMIC — a static one in this file would be hoisted
// and resolved before `register()` ever ran.
//
// ⭐ Those two imports are the POINT, not an inconvenience to route around: the card's population and
// its within-project order are defined as "whatever the `live sessions` KPI tile and the Terminals
// page already use". A test that re-spelled either predicate locally would keep passing after the
// shared one changed, which is precisely the drift it exists to catch.
register("./_tsxLoaderHook.mjs", import.meta.url);

const {
  byProjectThenManager, canMountTerminal, liveExpandedSession, toggleExpandedSession,
  workspaceRunningSessions, workspaceSessionsSummary,
} = await import("../src/lib/workspaceSessions.ts");

/**
 * A minimal session row — only the fields the derivations actually read. `createdAt` is a plain
 * ordinal rather than a real date so an ordering expectation is readable at a glance; the comparator
 * only ever compares them against each other.
 */
const s = (over = {}) => ({
  id: over.id ?? "s1",
  projectId: over.projectId ?? "p1",
  projectName: over.projectName ?? "Loom",
  agentName: over.agentName ?? "Dev",
  role: over.role ?? "worker",
  processState: over.processState ?? "live",
  busy: over.busy ?? false,
  createdAt: over.createdAt ?? "2026-11-04T00:00:00.000Z",
  lastActivity: over.lastActivity ?? "2026-11-04T00:00:00.000Z",
  parentSessionId: over.parentSessionId ?? null,
  ...over,
});

const ids = (rows) => rows.map((r) => r.id);

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── workspaceRunningSessions: the population ───────────────────────────────────────────────────

// 1) THE HEADLINE CLAIM. The card's population is the `live sessions` KPI tile's own — companions
//    out, `starting` IN (isLiveSession counts it), everything else that is not running out. Each
//    exclusion gets a row that WOULD be listed but for the one field under test, so a filter that
//    simply dropped everything could not pass this.
check("lists live + starting, excludes companions and every non-running state", () => {
  const rows = workspaceRunningSessions([
    s({ id: "live", processState: "live" }),
    s({ id: "starting", processState: "starting" }),
    s({ id: "exited", processState: "exited" }),
    s({ id: "none", processState: "none" }),
    // `assistant` IS the companion role (lib/sessions.ts COMPANION_ROLE) and this row is otherwise
    // a perfectly listable live session — the role is the only thing keeping it out.
    s({ id: "companion", role: "assistant", processState: "live" }),
  ]);
  assert.deepEqual(ids(rows).sort(), ["live", "starting"]);
});

// 2) The companion exclusion is the COMPANION GUARD (card 5c87f4b6) — a companion must never reach a
//    raw pty + stdin Composer. Asserted on its own so a future widening of the population cannot
//    quietly take this with it: a companion stays out even when it is the ONLY running session.
check("a companion is excluded even when it is the only running session", () => {
  assert.deepEqual(workspaceRunningSessions([s({ id: "c", role: "assistant" })]), []);
});

// 3) A platform lead / auditor / plain session IS fleet — only `assistant` is not. Without this the
//    rule above would be satisfied by a filter that dropped every non-manager/worker role.
check("platform, auditor and role-less sessions are listed", () => {
  const rows = workspaceRunningSessions([
    s({ id: "plat", role: "platform" }),
    s({ id: "aud", role: "auditor" }),
    s({ id: "plain", role: null }),
  ]);
  assert.deepEqual(ids(rows).sort(), ["aud", "plain", "plat"]);
});

// 4) Degenerate inputs. `undefined` is what an unresolved `useQuery` hands the card on its first
//    render, so it must return an empty array rather than throwing or returning undefined.
check("undefined and empty inputs give an empty array", () => {
  assert.deepEqual(workspaceRunningSessions(undefined), []);
  assert.deepEqual(workspaceRunningSessions([]), []);
});

// 5) The caller's array is SHARED state (React Query's own cached `["allSessions"]` data), so sorting
//    it in place would re-order a list other consumers hold a reference to, with no re-render to tell
//    them. (The KPI tile, the tree and the project grid all read that same entry.)
check("the caller's array is not sorted in place", () => {
  const input = [s({ id: "b", projectName: "Zulu" }), s({ id: "a", projectName: "Alpha" })];
  const before = ids(input);
  const out = workspaceRunningSessions(input);
  assert.deepEqual(ids(input), before, "the input array was sorted in place");
  assert.notEqual(out, input, "the same array instance was returned");
  assert.deepEqual(ids(out), ["a", "b"]);
});

// ── byProjectThenManager: the render order ─────────────────────────────────────────────────────

// 6) Project-major, and the control: with the project names swapped the SAME two rows come back the
//    other way round. Without the control this would pass against a build that merely reversed.
check("project name leads the order", () => {
  const alpha = s({ id: "x", projectName: "Alpha" });
  const zulu = s({ id: "y", projectName: "Zulu" });
  assert.deepEqual(ids([zulu, alpha].sort(byProjectThenManager)), ["x", "y"]);
  assert.deepEqual(
    ids([s({ id: "x", projectName: "Zulu" }), s({ id: "y", projectName: "Alpha" })].sort(byProjectThenManager)),
    ["y", "x"],
  );
});

// 7) Case does not split the alphabet — `sensitivity: "base"`, not a raw `<` on UTF-16 code units
//    (which puts every capitalised project ahead of every lowercase one).
check("project ordering is case-insensitive", () => {
  const rows = [
    s({ id: "z", projectName: "Zulu" }),
    s({ id: "a", projectName: "alpha" }),
    s({ id: "m", projectName: "Mike" }),
  ];
  assert.deepEqual(ids(rows.slice().sort(byProjectThenManager)), ["a", "m", "z"]);
});

// 8) WITHIN a project the shared comparator decides: managers first, then createdAt DESC, then id.
//    Asserted as a whole list across TWO projects so a build that sorted only by project (leaving
//    each block in arrival order) fails here.
check("within a project, managers lead and then newest-first", () => {
  const rows = [
    s({ id: "b-old-worker", projectName: "Beta", createdAt: "2026-11-01T00:00:00.000Z" }),
    s({ id: "a-worker", projectName: "Alpha", createdAt: "2026-11-01T00:00:00.000Z" }),
    s({ id: "b-new-worker", projectName: "Beta", createdAt: "2026-11-03T00:00:00.000Z" }),
    s({ id: "b-manager", projectName: "Beta", role: "manager", createdAt: "2026-10-01T00:00:00.000Z" }),
    s({ id: "a-manager", projectName: "Alpha", role: "manager", createdAt: "2026-10-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(rows.slice().sort(byProjectThenManager)), [
    "a-manager", "a-worker",
    // The manager leads its own project's block despite being the OLDEST row in it — which is what
    // tells this apart from a plain newest-first sort.
    "b-manager", "b-new-worker", "b-old-worker",
  ]);
});

// 9) Two DIFFERENT projects sharing a display NAME must not interleave their sessions. The projectId
//    breaks it, so each block stays whole and in the same place between renders.
check("same-named projects keep separate blocks, broken by projectId", () => {
  const rows = [
    s({ id: "p2a", projectId: "p2", projectName: "Loom" }),
    s({ id: "p1a", projectId: "p1", projectName: "Loom" }),
    s({ id: "p2b", projectId: "p2", projectName: "Loom", createdAt: "2026-10-01T00:00:00.000Z" }),
    s({ id: "p1b", projectId: "p1", projectName: "Loom", createdAt: "2026-10-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(rows.slice().sort(byProjectThenManager)), ["p1a", "p1b", "p2a", "p2b"]);
});

// 10) ⛔ The order must be independent of `busy` and `lastActivity`: a row that jumps on a poll is
//     the regression `byManagerThenCreated` was introduced to end, and the card re-sorts on every
//     `["allSessions"]` refetch. Two lists identical but for those two fields must agree exactly.
check("busy and lastActivity do not move a row", () => {
  const base = [
    s({ id: "one", createdAt: "2026-11-01T00:00:00.000Z" }),
    s({ id: "two", createdAt: "2026-11-02T00:00:00.000Z" }),
    s({ id: "three", createdAt: "2026-11-03T00:00:00.000Z" }),
  ];
  const churned = base.map((row, i) => ({
    ...row,
    busy: i === 0,
    lastActivity: i === 0 ? "2026-11-04T23:00:00.000Z" : "2026-01-01T00:00:00.000Z",
  }));
  assert.deepEqual(ids(workspaceRunningSessions(churned)), ids(workspaceRunningSessions(base)));
});

// 11) A total order, not a stable pass over arrival order: two shuffles of the same rows agree.
check("the result is independent of input order", () => {
  const rows = [
    s({ id: "a", projectName: "Alpha" }),
    s({ id: "b", projectName: "Beta" }),
    s({ id: "c", projectName: "Charlie" }),
  ];
  assert.deepEqual(ids(workspaceRunningSessions(rows)), ["a", "b", "c"]);
  assert.deepEqual(ids(workspaceRunningSessions(rows.slice().reverse())), ["a", "b", "c"]);
});

// ── toggleExpandedSession: the single-mount contract ───────────────────────────────────────────

// 12) THE PERFORMANCE CONTRACT. At most one mount, ever: a different row MOVES the mount rather than
//     adding one, and a re-click RELEASES it (so the only mount can be given up without navigating
//     away). The return type is a single id or null — there is structurally no way to hold two.
check("at most one row is ever expanded", () => {
  assert.equal(toggleExpandedSession(null, "a"), "a");     // nothing → one
  assert.equal(toggleExpandedSession("a", "b"), "b");      // moves, never adds
  assert.equal(toggleExpandedSession("a", "a"), null);     // re-click releases the mount
  assert.equal(toggleExpandedSession(null, "a"), "a");     // and re-opening works after a release
});

// ── liveExpandedSession: the mount cannot outlive its row ──────────────────────────────────────

// 13) A session that exits / is stopped / is archived while its terminal is open drops off
//     `["allSessions"]`, taking its row with it. The mount must go too, or an xterm stays attached
//     to a dead pty with no row left to collapse it from.
check("an expansion whose row is gone resolves to null", () => {
  const rows = [s({ id: "alive" })];
  assert.equal(liveExpandedSession("alive", rows), "alive");
  assert.equal(liveExpandedSession("departed", rows), null);
  assert.equal(liveExpandedSession("alive", []), null);
  assert.equal(liveExpandedSession(null, rows), null);
});

// 14) ⛔ liveExpandedSession is deliberately NOT also the mountability check: a `starting` row stays
//     expanded so it can state why it has nothing to draw. Fold canMountTerminal in here and that
//     row collapses itself instead.
check("a starting row's expansion survives — only canMountTerminal gates the pane", () => {
  const starting = s({ id: "boot", processState: "starting" });
  assert.equal(liveExpandedSession("boot", [starting]), "boot");
  assert.equal(canMountTerminal(starting), false);
  assert.equal(canMountTerminal(s({ processState: "live" })), true);
});

// 15) canMountTerminal over every ProcessState, so a new state can never default to "mount it" by
//     omission — only `live` has a pty to attach to.
check("only `live` is mountable", () => {
  const mountable = ["none", "starting", "live", "exited"].filter((p) => canMountTerminal({ processState: p }));
  assert.deepEqual(mountable, ["live"]);
});

// ── workspaceSessionsSummary: the footer ───────────────────────────────────────────────────────

// 16) Singular/plural on BOTH halves independently, and a distinct empty sentence. A project is
//     counted by projectId, not projectName, so two same-named projects read as two.
check("the summary pluralises sessions and projects independently", () => {
  assert.equal(workspaceSessionsSummary([]), "No sessions are running.");
  assert.equal(
    workspaceSessionsSummary([s({ id: "a" })]),
    "1 running session across 1 project.",
  );
  assert.equal(
    workspaceSessionsSummary([s({ id: "a" }), s({ id: "b" })]),
    "2 running sessions across 1 project.",
  );
  assert.equal(
    workspaceSessionsSummary([s({ id: "a", projectId: "p1" }), s({ id: "b", projectId: "p2" })]),
    "2 running sessions across 2 projects.",
  );
  // Same NAME, different ids ⇒ two projects. Counting by name would read "1 project" here.
  assert.equal(
    workspaceSessionsSummary([
      s({ id: "a", projectId: "p1", projectName: "Loom" }),
      s({ id: "b", projectId: "p2", projectName: "Loom" }),
    ]),
    "2 running sessions across 2 projects.",
  );
});

console.log(`\nAll ${pass} checks passed`);
