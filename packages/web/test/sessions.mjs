// Hermetic unit test for the web-side session grouping in src/lib/sessions.ts — the pure, dependency-free
// groupSessionRows() behind the Terminals page. No daemon, no claude, no React: it imports the TS source
// directly via Node's type stripping and asserts on plain objects, so it exercises the REAL shipped helper
// and can't drift from a copy.
//
// Like diff.mjs / companion.mjs, the web package has no test runner, so this is a self-contained node script
// wired into @loom/web's `build` script (which CI runs via `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/sessions.mjs
import assert from "node:assert/strict";
import { groupSessionRows, canResumeSession, goLiveHeldControl, goLiveSessionPill, holdsGoLiveSlot, projectFilterOptions, sessionRowSuffixes, shortCardTitle } from "../src/lib/sessions.ts";

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

// ── canResumeSession — the shared Resume gate (SessionActions + RunHistory) ────────────────────────────
// findings #14/#15: auto-archive-on-exit means almost every non-live row is ARCHIVED, not "exited", so
// the gate must treat an already-archived row as resumable too — not just the ephemeral exited window.

check("a live session cannot resume", () => {
  assert.equal(canResumeSession({ processState: "live", resumability: "unknown" }), false);
});

check("a still-exited-not-yet-archived session can resume (the old reachable case)", () => {
  assert.equal(canResumeSession({ processState: "exited", resumability: "unknown", archivedAt: null }), true);
});

check("an ARCHIVED session exposes resume — the durable path this fix adds", () => {
  assert.equal(canResumeSession({ processState: "exited", resumability: "unknown", archivedAt: "2026-07-01T00:00:00.000Z" }), true);
  assert.equal(canResumeSession({ processState: "exited", resumability: "resumable", archivedAt: "2026-07-01T00:00:00.000Z" }), true);
});

check("a confirmed-dead session never exposes resume, archived or not", () => {
  assert.equal(canResumeSession({ processState: "exited", resumability: "dead", archivedAt: null }), false);
  assert.equal(canResumeSession({ processState: "exited", resumability: "dead", archivedAt: "2026-07-01T00:00:00.000Z" }), false);
});

// ── The manager go-live guard (card 318b5a21) ─────────────────────────────────────────────────────
//
// THE DEFECT THIS PINS: both spawn surfaces asked `processState === "live"`, so for the whole of a
// spawn's own startup — the row sitting at `starting` — the guard read "nothing is running", left the
// spawn button enabled, and a second click minted a SECOND manager. The daemon has no guard of its
// own (`SessionService.startNew` inserts a fresh `starting` row for any agent, however many are
// already up), so this predicate is the only thing between a double-click and two orchestrators.
//
// `starting` is therefore the ONE case worth a test, and it is asserted ALONGSIDE both polarities it
// has to stay distinct from: `live` (which the old form already caught) and `exited` (which must keep
// releasing the guard, or a finished manager could never be restarted).

check("holdsGoLiveSlot: a STARTING session holds the slot — the double-spawn window this closes", () => {
  assert.equal(holdsGoLiveSlot({ processState: "starting" }), true);
});

check("holdsGoLiveSlot: a LIVE session holds it too — the case the narrow form already caught", () => {
  assert.equal(holdsGoLiveSlot({ processState: "live" }), true);
});

check("holdsGoLiveSlot: every terminal/absent state RELEASES it", () => {
  // The release direction is as load-bearing as the hold: a guard that never let go would make a
  // finished manager permanently un-spawnable, which is a worse bug than the one being fixed.
  assert.equal(holdsGoLiveSlot({ processState: "exited" }), false);
  assert.equal(holdsGoLiveSlot({ processState: "none" }), false);
  // And an absent session at all — the no-session case every caller passes through here.
  assert.equal(holdsGoLiveSlot(null), false);
  assert.equal(holdsGoLiveSlot(undefined), false);
});

check("goLiveHeldControl: a starting manager's held button does NOT claim to be live", () => {
  // The whole point of the pair: widening the guard without widening its WORDING would put "Live"
  // over a session the guard itself knows is only starting.
  const starting = goLiveHeldControl({ processState: "starting" });
  const live = goLiveHeldControl({ processState: "live" });
  assert.equal(starting.label, "Starting…");
  assert.match(starting.title, /starting/);
  assert.equal(live.label, "Live");
  assert.notEqual(starting.label, live.label, "the two held states must be distinguishable to a reader");
});

check("goLiveSessionPill: starting reads as pending; live/busy keep their existing wording", () => {
  assert.deepEqual(goLiveSessionPill({ processState: "starting", busy: false }), { label: "starting", pending: true });
  // A starting row's own `busy` flag is irrelevant — it has not taken a turn yet.
  assert.deepEqual(goLiveSessionPill({ processState: "starting", busy: true }), { label: "starting", pending: true });
  assert.deepEqual(goLiveSessionPill({ processState: "live", busy: false }), { label: "live", pending: false });
  assert.deepEqual(goLiveSessionPill({ processState: "live", busy: true }), { label: "working", pending: true });
});

// ── projectFilterOptions: the live set is not the whole option list (card d72994d7) ──────────────

// One live session, only the field this helper reads.
const P = (projectName) => ({ projectName });

check("projectFilterOptions: a SCOPED project with zero live sessions is still offered", () => {
  // THE DEFECT, stated as the one claim that separates the fix from what it replaced: the scoped
  // project names no live session, so the old live-set-only derivation left it out — and a <select>
  // whose value matches no option renders its FIRST one, which is the page's "All (N)" entry.
  const opts = projectFilterOptions([P("Fire Studio")], ["Loom", "Loom"]);
  assert.ok(opts.includes("Loom"), "the scoped project must be selectable even with nothing live in it");
  // And it did not replace the live one: widening back to a project that IS running must still work.
  assert.deepEqual(opts, ["Fire Studio", "Loom"], "sorted, deduped, both projects present");
});

check("projectFilterOptions: a project with NO live sessions and NO hold is NOT invented", () => {
  // The other polarity — without this the first check is satisfied by a helper that offers every
  // project it has ever seen, which would put dead projects in the god-eye page's filter forever.
  assert.deepEqual(projectFilterOptions([P("Fire Studio")], []), ["Fire Studio"]);
});

check("projectFilterOptions: a held name that IS live appears exactly once", () => {
  const opts = projectFilterOptions([P("Loom"), P("Loom"), P("Fire Studio")], ["Loom"]);
  assert.deepEqual(opts, ["Fire Studio", "Loom"], "the live set and the hold must not double up");
});

check("projectFilterOptions: empty/absent holds are dropped, never drawn as a blank option", () => {
  // "" is the "All" entry's own value — emitting it here would mint a second, nameless All. undefined
  // is the real god-eye mount (no scoped project) and the real loading state (project?.name).
  assert.deepEqual(projectFilterOptions([P("Loom")], ["", undefined, null]), ["Loom"]);
  // The god-eye page AT REST: no scoped project, filter "" — byte-identical to the old derivation.
  assert.deepEqual(projectFilterOptions([P("Loom"), P("Fire Studio")], [undefined, ""]), ["Fire Studio", "Loom"]);
  // …and with nothing live at all it is empty, so the page draws "All (0)" alone and says so honestly.
  assert.deepEqual(projectFilterOptions([], [undefined, ""]), []);
});

check("projectFilterOptions: a FILTER value whose last session exited stays offered", () => {
  // The classic god-eye page's own form of the same defect: the reader picked a project, its last
  // session then exited, and the control went back to claiming "All" while still filtering to it.
  // Distinct from the scoped case above — here there is no scoped project at all, only a selection.
  const opts = projectFilterOptions([P("Fire Studio")], [undefined, "Loom"]);
  assert.ok(opts.includes("Loom"), "the current selection must survive its last session exiting");
  assert.deepEqual(opts, ["Fire Studio", "Loom"]);
});

check("projectFilterOptions: the default `held` keeps a one-argument call working", () => {
  // The signature stays usable by any caller that has no selection to preserve.
  assert.deepEqual(projectFilterOptions([P("Loom")]), ["Loom"]);
});

// ── sessionRowSuffixes (card eb516fba, audit B-22): two "Dev" rows in the tree must read differently ──
check("only same-named sessions get a suffix: card title first, then branch tail, then short id", () => {
  const titles = new Map([["t1", "fix(daemon): stop double-charging on retried webhooks"]]);
  const rows = [
    { id: "dev1-aaaaaaaa", agentName: "Dev", taskId: "t1", branch: "loom/aaaa1111bbbb" },
    { id: "dev2-bbbbbbbb", agentName: "Dev", taskId: "t2", branch: "loom/cccc2222dddd" },
    { id: "dev3-cccccccc", agentName: "Dev", taskId: null, branch: null },
    { id: "qa-11111111", agentName: "QA Tester", taskId: "t1", branch: "loom/eeee" },
  ];
  const s = sessionRowSuffixes(rows, titles);
  assert.equal(s.get("dev1-aaaaaaaa"), "stop double-charging on retried webhooks", "the card title, commit-type lead dropped");
  assert.equal(s.get("dev2-bbbbbbbb"), "cccc2222", "no title known yet: the branch's own tail");
  assert.equal(s.get("dev3-cccccccc"), "dev3-ccc", "no branch either: the short id the tile and node head show");
  // The control: a uniquely named row is left EXACTLY as it was, even though it holds a titled card.
  assert.equal(s.has("qa-11111111"), false);
  assert.equal(sessionRowSuffixes([rows[0], rows[3]], titles).size, 0, "no repeated name, no suffix at all");
});

check("shortCardTitle drops only a Conventional Commits lead", () => {
  assert.equal(shortCardTitle("feat(web): remember steps"), "remember steps");
  assert.equal(shortCardTitle("fix!: hotfix"), "hotfix");
  // The control: a title that merely STARTS with a word and a colon is not a commit lead and is kept.
  assert.equal(shortCardTitle("Deploy: the new gateway"), "Deploy: the new gateway");
  assert.equal(shortCardTitle("Plain title: with a colon"), "Plain title: with a colon");
});

console.log(`\n${pass} passed`);
