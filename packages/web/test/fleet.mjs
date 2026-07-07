// Hermetic unit test for the web-side fleet roll-up + archived-fold logic in src/lib/fleet.ts — the pure,
// JSX-free helpers behind the compact FleetCard (components/fleet.tsx). It covers the "both-in-one" fix:
// a project's ARCHIVED (exited) sessions fold into the card's worker buckets as muted/offline history, the
// fold is CAPPED so a big archive can't flood the composition bar, and the live roll-up severity is driven
// by the running set only. No daemon, no claude, no React: it imports the TS source directly via Node's
// type stripping and asserts on plain objects, so it exercises the REAL shipped helpers.
//
// Like companion.mjs/diff.mjs, the web package has no test runner, so this is a self-contained node script,
// wired into @loom/web's `build` script (which CI runs via `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/fleet.mjs
import assert from "node:assert/strict";
import {
  ARCHIVED_FOLD_CAP, capArchived, fleetRollup, workerBuckets,
  isStuckBusy, hasSupervisedWorkers, isActiveWaitingSnooze, STUCK_BUSY_MS,
} from "../src/lib/fleet.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// Minimal session factory — only the fields the roll-up helpers read (role/processState/busy/rateLimitedUntil).
let seq = 0;
const s = (o = {}) => ({
  id: `sess-${++seq}`,
  role: o.role ?? "worker",
  processState: o.processState ?? "live",
  busy: o.busy ?? false,
  rateLimitedUntil: o.rateLimitedUntil ?? null,
});
const running = (o) => s({ processState: "live", ...o });
const archivedSess = (o) => s({ processState: "exited", ...o }); // ArchivedSessionListItem is exited on the wire
const future = () => new Date(Date.now() + 60_000).toISOString();

// ── The cap (display-only: bounds how many archived rows feed the card) ───────────────────────────────

check("capArchived defaults to ARCHIVED_FOLD_CAP and never returns more", () => {
  const many = Array.from({ length: 20 }, () => archivedSess());
  assert.equal(capArchived(many).length, ARCHIVED_FOLD_CAP, "a big archive is capped to the fold cap");
  assert.ok(ARCHIVED_FOLD_CAP >= 5 && ARCHIVED_FOLD_CAP <= 8, "the cap is a sane 5–8 rows");
});

check("capArchived returns everything when under the cap, and honors an explicit cap", () => {
  const three = Array.from({ length: 3 }, () => archivedSess());
  assert.equal(capArchived(three).length, 3, "under the cap → unchanged");
  assert.equal(capArchived(three, 2).length, 2, "an explicit cap wins");
  assert.equal(capArchived([]).length, 0, "empty stays empty");
});

// ── The merged running+archived worker buckets (archived land in `offline`, rendered muted) ───────────

check("workerBuckets folds capped archived workers into the offline bucket alongside live workers", () => {
  const liveWorkers = [running({ busy: true }), running({ busy: false })]; // 1 busy, 1 idle
  const archivedWorkers = Array.from({ length: 4 }, () => archivedSess());
  const buckets = workerBuckets([...liveWorkers, ...capArchived(archivedWorkers)]);
  assert.deepEqual(buckets, { busy: 1, idle: 1, rl: 0, offline: 4, total: 6 });
});

check("a large archive is capped BEFORE it reaches the buckets, so offline can't run away", () => {
  const liveWorkers = [running({ busy: false })];
  const archivedWorkers = Array.from({ length: 30 }, () => archivedSess());
  const buckets = workerBuckets([...liveWorkers, ...capArchived(archivedWorkers)]);
  assert.equal(buckets.offline, ARCHIVED_FOLD_CAP, "offline is bounded by the fold cap, not the raw count");
  assert.equal(buckets.idle, 1);
  assert.equal(buckets.total, 1 + ARCHIVED_FOLD_CAP);
});

// ── The roll-up severity: LIVE state only — a finished session must never drive the card's status ──────

check("fleetRollup(running) reads live state — a live manager with idle workers is 'idle'", () => {
  const set = [running({ role: "manager" }), running({ busy: false })];
  assert.deepEqual(fleetRollup(set), { tone: "phosphor", label: "idle" });
});

check("fleetRollup escalates to busy on any live busy session, and red on a live rate-limit", () => {
  assert.equal(fleetRollup([running({ role: "manager" }), running({ busy: true })]).label, "busy");
  assert.equal(fleetRollup([running({ role: "manager", rateLimitedUntil: future() })]).label, "rate-limited");
});

check("an archived-only project (no live manager) rolls up to 'no live manager', not a stale live status", () => {
  // Even a still-future rateLimitedUntil on an EXITED row must not paint the running roll-up red: the card
  // feeds fleetRollup the RUNNING set only, so archived history never drives severity.
  const archivedOnly = [archivedSess({ role: "manager", rateLimitedUntil: future() }), archivedSess()];
  const runningSet = []; // everything archived
  assert.deepEqual(fleetRollup(runningSet), { tone: "muted", label: "no live manager" });
  // Sanity: if those exited rows WERE (wrongly) merged into the roll-up set, it would flip red — proving
  // the running-only feed is load-bearing.
  assert.equal(fleetRollup(archivedOnly).label, "rate-limited");
});

// ── STUCK-BUSY heuristic + its false-positive exclusions (board card a1f06bcc) ─────────────────────────

const stale = () => new Date(Date.now() - (STUCK_BUSY_MS + 60_000)).toISOString();
const fresh = () => new Date().toISOString();

check("isStuckBusy flags a live+busy session with a stale lastActivity and no exclusion context (positive control)", () => {
  const sess = { ...running({ busy: true }), lastActivity: stale() };
  assert.equal(isStuckBusy(sess), true);
});

check("isStuckBusy does NOT flag a fresh-activity busy session (not stale long enough)", () => {
  const sess = { ...running({ busy: true }), lastActivity: fresh() };
  assert.equal(isStuckBusy(sess), false);
});

check("isStuckBusy does NOT flag an idle (busy:false) session regardless of staleness", () => {
  const sess = { ...running({ busy: false }), lastActivity: stale() };
  assert.equal(isStuckBusy(sess), false);
});

check("isStuckBusy excludes a manager supervising live/pending workers — it's parked, not stuck", () => {
  const sess = { ...running({ busy: true }), lastActivity: stale() };
  assert.equal(isStuckBusy(sess, { hasSupervisedWorkers: true }), false);
});

check("isStuckBusy excludes a session with an active waiting-snooze — it self-reported the park", () => {
  const sess = { ...running({ busy: true }), lastActivity: stale() };
  assert.equal(isStuckBusy(sess, { isWaitingSnoozed: true }), false);
});

check("hasSupervisedWorkers is true for a manager with a LIVE worker, false with only exited/other-manager workers", () => {
  const mgr = { id: "mgr-1" };
  const liveChild = { id: "w-1", role: "worker", parentSessionId: "mgr-1", processState: "live" };
  const startingChild = { id: "w-2", role: "worker", parentSessionId: "mgr-1", processState: "starting" };
  const exitedChild = { id: "w-3", role: "worker", parentSessionId: "mgr-1", processState: "exited" };
  const otherMgrChild = { id: "w-4", role: "worker", parentSessionId: "mgr-2", processState: "live" };
  assert.equal(hasSupervisedWorkers("mgr-1", [mgr, liveChild, otherMgrChild]), true, "a live child worker counts");
  assert.equal(hasSupervisedWorkers("mgr-1", [mgr, startingChild]), true, "a starting (dispatched, not yet live) child counts");
  assert.equal(hasSupervisedWorkers("mgr-1", [mgr, exitedChild, otherMgrChild]), false, "only exited/unrelated workers → false");
  assert.equal(hasSupervisedWorkers("mgr-1", [mgr]), false, "no children at all → false");
});

check("isActiveWaitingSnooze is true only for an unexpired idle_report('waiting') snooze", () => {
  const now = Date.now();
  const waitingActive = { kind: "idle_report", detail: { state: "waiting", snoozeUntil: new Date(now + 60_000).toISOString() } };
  const waitingExpired = { kind: "idle_report", detail: { state: "waiting", snoozeUntil: new Date(now - 60_000).toISOString() } };
  const workingState = { kind: "idle_report", detail: { state: "working" } };
  const idleEscalated = { kind: "idle_escalated", detail: { state: "waiting", snoozeUntil: new Date(now + 60_000).toISOString() } };
  assert.equal(isActiveWaitingSnooze(waitingActive, now), true);
  assert.equal(isActiveWaitingSnooze(waitingExpired, now), false, "a lapsed snooze no longer excludes");
  assert.equal(isActiveWaitingSnooze(workingState, now), false, "a non-waiting state never excludes");
  assert.equal(isActiveWaitingSnooze(idleEscalated, now), false, "only idle_report (not idle_escalated) carries a snooze");
  assert.equal(isActiveWaitingSnooze(undefined, now), false, "no event at all → not snoozed");
});

console.log(`\n${pass} passed`);
