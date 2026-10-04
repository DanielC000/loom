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
  activeBootStuckAlerts, activeVaultLockAlerts,
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

// ── BOOT STUCK pairing (card b1da256d round 2, item 3b) — extracted out of lib/attention.ts ────────────

let evSeq = 0;
const bootEv = (o = {}) => ({
  id: `ev-${++evSeq}`,
  ts: o.ts ?? new Date(evSeq).toISOString(), // monotonically increasing by default
  kind: o.kind ?? "claude_boot_dialog_stuck",
  workerSessionId: o.workerSessionId ?? "sess-stuck-1",
  managerSessionId: o.managerSessionId ?? "sess-stuck-1",
  taskId: o.taskId ?? null,
  detail: o.detail ?? { parentNudged: false },
});
const alwaysLive = () => true;
const alwaysDead = () => false;

check("activeBootStuckAlerts: a lone stuck event (nobody else addressed) on a LIVE session surfaces an alert", () => {
  const stuck = bootEv({ workerSessionId: "sess-a", managerSessionId: "sess-a" });
  const alerts = activeBootStuckAlerts([stuck], alwaysLive);
  assert.equal(alerts.length, 1, "stuck only ⇒ item");
  assert.equal(alerts[0].sessionId, "sess-a");
  assert.equal(alerts[0].event.id, stuck.id);
});

check("activeBootStuckAlerts: a stuck event followed by its resolved counterpart clears the alert", () => {
  const sid = "sess-b";
  const stuck = bootEv({ workerSessionId: sid, managerSessionId: sid, ts: "2026-01-01T00:00:00.000Z" });
  const resolved = bootEv({ workerSessionId: sid, managerSessionId: sid, kind: "claude_boot_dialog_resolved", detail: {}, ts: "2026-01-01T00:00:01.000Z" });
  const alerts = activeBootStuckAlerts([stuck, resolved], alwaysLive);
  assert.equal(alerts.length, 0, "stuck then resolved ⇒ none");
});

check("activeBootStuckAlerts: a resolved event followed by a NEW stuck episode re-surfaces the alert", () => {
  const sid = "sess-c";
  const resolved = bootEv({ workerSessionId: sid, managerSessionId: sid, kind: "claude_boot_dialog_resolved", detail: {}, ts: "2026-01-01T00:00:00.000Z" });
  const stuck = bootEv({ workerSessionId: sid, managerSessionId: sid, ts: "2026-01-01T00:00:01.000Z" });
  const alerts = activeBootStuckAlerts([resolved, stuck], alwaysLive);
  assert.equal(alerts.length, 1, "resolved then stuck ⇒ item — latest wins, in EITHER order in the input array");
  assert.equal(alerts[0].sessionId, sid);
});

check("activeBootStuckAlerts: a stuck session that's no longer live is dropped — nobody can act on it anymore", () => {
  const stuck = bootEv({ workerSessionId: "sess-d", managerSessionId: "sess-d" });
  const alerts = activeBootStuckAlerts([stuck], alwaysDead);
  assert.equal(alerts.length, 0, "a non-live session ⇒ none");
});

check("activeBootStuckAlerts: a stuck event where someone else WAS addressed (parentNudged:true) never surfaces", () => {
  const stuck = bootEv({ workerSessionId: "sess-e", managerSessionId: "sess-e", detail: { parentNudged: true } });
  const alerts = activeBootStuckAlerts([stuck], alwaysLive);
  assert.equal(alerts.length, 0, "parentNudged:true ⇒ none");
});

check("activeBootStuckAlerts: unsorted input is sorted internally — order of the array passed in doesn't matter", () => {
  const sid = "sess-f";
  const stuck = bootEv({ workerSessionId: sid, managerSessionId: sid, ts: "2026-01-01T00:00:00.000Z" });
  const resolved = bootEv({ workerSessionId: sid, managerSessionId: sid, kind: "claude_boot_dialog_resolved", detail: {}, ts: "2026-01-01T00:00:01.000Z" });
  // Pass resolved BEFORE stuck in array order — the function must sort by `ts`, not trust array order.
  const alerts = activeBootStuckAlerts([resolved, stuck], alwaysLive);
  assert.equal(alerts.length, 0, "still clears — sorted by ts internally, not by array position");
});

// Card 43084723 — M1 recycled → M2: the stuck worker's alert must persist while the worker is live and
// stuck, even though its FILING manager (M1) stopped being live. `activeBootStuckAlerts` itself was never
// the bug (it already keys/checks liveness by workerSessionId, proven above) — the bug lived entirely in
// WHICH events `lib/attention.ts`'s useAttention fed into it. `selectByOldPerManagerFanOut` below is the
// OLD, now-REMOVED selection logic (a `managerId`-keyed query per candidate, where a candidate was any
// PARENTLESS live session) kept here ONLY as a regression witness — it is not imported from source
// anymore (there is nothing left in attention.ts/fleet.ts to import; the real fix replaced it with ONE
// unconditional, kind-filtered fetch, which this test models as "no selection at all").
function selectByOldPerManagerFanOut(events, sessions) {
  const candidateIds = new Set(
    sessions.filter((s) => s.processState === "live" && !s.parentSessionId).map((s) => s.id));
  return events.filter((e) => candidateIds.has(e.managerSessionId));
}
check("card 43084723 — RED: the OLD per-manager fan-out drops W's stuck alert once its filing manager M1 is recycled away", () => {
  const sessions = [
    { id: "M1", role: "manager", processState: "exited", parentSessionId: null }, // recycled away
    { id: "M2", role: "manager", processState: "live", parentSessionId: null },   // W's new manager
    { id: "W", role: "worker", processState: "live", parentSessionId: "M2" },     // still live and stuck
  ];
  const stuck = bootEv({ workerSessionId: "W", managerSessionId: "M1" }); // filed before the recycle; never rewritten
  const oldSelection = selectByOldPerManagerFanOut([stuck], sessions);
  assert.equal(oldSelection.length, 0, "RED (reproduced): M1 is no longer a live candidate, so the old fan-out never fetches this row at all");
  const alertsFromOldSelection = activeBootStuckAlerts(oldSelection, alwaysLive);
  assert.equal(alertsFromOldSelection.length, 0, "RED (reproduced): with nothing selected, the alert never surfaces even though W is live and stuck");
});
check("card 43084723 — GREEN: the fix (one unconditional, kind-filtered fetch) keeps W's alert visible after M1 recycles", () => {
  const stuck = bootEv({ workerSessionId: "W", managerSessionId: "M1" });
  // The real fix: useAttention no longer selects by candidate/manager liveness at all — it fetches ALL
  // claude_boot_dialog_stuck/resolved rows across the fleet in one call and feeds them straight in.
  const alerts = activeBootStuckAlerts([stuck], (sessionId) => sessionId === "W"); // only W is live; M1 is not
  assert.equal(alerts.length, 1, "GREEN: W's alert surfaces — keyed/checked on W's OWN liveness, never M1's");
  assert.equal(alerts[0].sessionId, "W");
});

// ── VAULT LOCK pairing (card 227d9f0b round 2) — mirrors the BOOT STUCK pairing tests above, keyed by
// detail.repoPath instead of a session id, with NO liveness filter (a stale vault lock isn't owned by
// any live session). ──────────────────────────────────────────────────────────────────────────────────
let vlSeq = 0;
const vaultLockEv = (o = {}) => ({
  id: `vl-${++vlSeq}`,
  ts: o.ts ?? new Date(vlSeq).toISOString(),
  kind: o.kind ?? "vault_index_lock_stale",
  workerSessionId: null,
  managerSessionId: "",
  taskId: null,
  detail: o.detail ?? { repoPath: "/vault/a" },
});

check("activeVaultLockAlerts: a lone stale event surfaces an alert", () => {
  const stale = vaultLockEv({ detail: { repoPath: "/vault/a" } });
  const alerts = activeVaultLockAlerts([stale]);
  assert.equal(alerts.length, 1, "stale only ⇒ item");
  assert.equal(alerts[0].id, stale.id);
});

check("activeVaultLockAlerts: a stale event followed by its cleared counterpart clears the alert", () => {
  const stale = vaultLockEv({ detail: { repoPath: "/vault/b" }, ts: "2026-01-01T00:00:00.000Z" });
  const cleared = vaultLockEv({ kind: "vault_index_lock_cleared", detail: { repoPath: "/vault/b" }, ts: "2026-01-01T00:00:01.000Z" });
  const alerts = activeVaultLockAlerts([stale, cleared]);
  assert.equal(alerts.length, 0, "stale then cleared ⇒ none");
});

check("activeVaultLockAlerts: a cleared event followed by a NEW stale episode re-surfaces the alert", () => {
  const cleared = vaultLockEv({ kind: "vault_index_lock_cleared", detail: { repoPath: "/vault/c" }, ts: "2026-01-01T00:00:00.000Z" });
  const stale = vaultLockEv({ detail: { repoPath: "/vault/c" }, ts: "2026-01-01T00:00:01.000Z" });
  const alerts = activeVaultLockAlerts([cleared, stale]);
  assert.equal(alerts.length, 1, "cleared then stale ⇒ item — latest wins, in EITHER order in the input array");
  assert.equal(alerts[0].detail.repoPath, "/vault/c");
});

check("activeVaultLockAlerts: unsorted input is sorted internally — order of the array passed in doesn't matter", () => {
  const stale = vaultLockEv({ detail: { repoPath: "/vault/d" }, ts: "2026-01-01T00:00:00.000Z" });
  const cleared = vaultLockEv({ kind: "vault_index_lock_cleared", detail: { repoPath: "/vault/d" }, ts: "2026-01-01T00:00:01.000Z" });
  // Pass cleared BEFORE stale in array order — the function must sort by `ts`, not trust array order.
  const alerts = activeVaultLockAlerts([cleared, stale]);
  assert.equal(alerts.length, 0, "still clears — sorted by ts internally, not by array position");
});

check("activeVaultLockAlerts: independent repoPaths are tracked separately — one cleared, one still stale", () => {
  const staleA = vaultLockEv({ detail: { repoPath: "/vault/e" } });
  const staleB = vaultLockEv({ detail: { repoPath: "/vault/f" }, ts: "2026-01-01T00:00:00.000Z" });
  const clearedB = vaultLockEv({ kind: "vault_index_lock_cleared", detail: { repoPath: "/vault/f" }, ts: "2026-01-01T00:00:01.000Z" });
  const alerts = activeVaultLockAlerts([staleA, staleB, clearedB]);
  assert.equal(alerts.length, 1, "only the still-stale repoPath surfaces");
  assert.equal(alerts[0].detail.repoPath, "/vault/e");
});

check("activeVaultLockAlerts: an event with no detail.repoPath is dropped defensively, never crashes", () => {
  const malformed = vaultLockEv({ detail: {} });
  const alerts = activeVaultLockAlerts([malformed]);
  assert.equal(alerts.length, 0, "no repoPath to key on ⇒ dropped, not surfaced");
});

check("activeVaultLockAlerts: an unrelated event kind is ignored", () => {
  const other = { ...vaultLockEv({ detail: { repoPath: "/vault/g" } }), kind: "merge_done" };
  const alerts = activeVaultLockAlerts([other]);
  assert.equal(alerts.length, 0, "a non-vault-lock kind never surfaces here");
});

console.log(`\n${pass} passed`);
