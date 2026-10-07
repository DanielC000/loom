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
  activeBootStuckAlerts, activeVaultLockAlerts, buildLatestMergeMap, activeCodexIsolationGapAlerts,
  resolveAttentionProjectId, attentionItemInProject,
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

// ── MERGE latest-wins pairing (card e5458ccd round 2, item 2) — extracted out of lib/attention.ts ──────
const mergeEv = (o = {}) => ({
  id: `ev-${++evSeq}`,
  ts: o.ts ?? new Date(evSeq).toISOString(),
  kind: o.kind ?? "merge_request",
  workerSessionId: o.workerSessionId ?? "worker-1",
  managerSessionId: o.managerSessionId ?? "mgr-1",
  taskId: o.taskId ?? "task-1",
  detail: o.detail ?? {},
});

check("buildLatestMergeMap: a lone merge_request surfaces as the latest for its task", () => {
  const req = mergeEv();
  const map = buildLatestMergeMap([req]);
  assert.equal(map.get("task-1")?.id, req.id);
});

check("buildLatestMergeMap: a LEGITIMATE later merge_done (no staleGenerationAttributed) correctly clears the pending request", () => {
  const req = mergeEv({ kind: "merge_request" });
  const done = mergeEv({ kind: "merge_done", detail: {} });
  const map = buildLatestMergeMap([req, done]);
  assert.equal(map.get("task-1")?.kind, "merge_done", "the real terminal event wins — this is NOT the bug being guarded against");
});

check("buildLatestMergeMap: a boot-time stale-generation attribution merge_done never clobbers the CURRENT generation's own live merge_request (card e5458ccd round 2, item 2)", () => {
  const liveRequest = mergeEv({ kind: "merge_request", workerSessionId: "worker-current" });
  const staleAttribution = mergeEv({
    kind: "merge_done", workerSessionId: "worker-stale", detail: { branch: null, staleGenerationAttributed: true, attributedLandedSha: "deadbeef" },
  });
  const map = buildLatestMergeMap([liveRequest, staleAttribution]);
  const result = map.get("task-1");
  assert.equal(result?.kind, "merge_request", "the stale attribution must be skipped — the live request stays the latest");
  assert.equal(result?.workerSessionId, "worker-current");
});

check("buildLatestMergeMap: a stale-generation attribution is the ONLY event for its task — the key is simply absent (no fabricated entry)", () => {
  const staleAttribution = mergeEv({ kind: "merge_done", detail: { branch: null, staleGenerationAttributed: true } });
  const map = buildLatestMergeMap([staleAttribution]);
  assert.equal(map.has("task-1"), false);
});

check("buildLatestMergeMap: unsorted input is sorted internally — order of the array passed in doesn't matter", () => {
  const req = mergeEv({ kind: "merge_request" });
  const staleAttribution = mergeEv({ kind: "merge_done", detail: { staleGenerationAttributed: true } });
  const map = buildLatestMergeMap([staleAttribution, req]); // stale attribution listed FIRST despite being later by ts
  assert.equal(map.get("task-1")?.kind, "merge_request");
});

check("buildLatestMergeMap: a later merge_landing_started (e.g. a stale re-tasked generation's own crashed landing attempt) never clobbers the CURRENT generation's own live merge_request (card 1ac74580)", () => {
  const liveRequest = mergeEv({ kind: "merge_request", workerSessionId: "worker-current" });
  const staleLandingStarted = mergeEv({ kind: "merge_landing_started", workerSessionId: "worker-stale", detail: { opId: "op-1" } });
  const map = buildLatestMergeMap([liveRequest, staleLandingStarted]);
  const result = map.get("task-1");
  assert.equal(result?.kind, "merge_request", "merge_landing_started is not in the allowlist — the live request stays the latest");
  assert.equal(result?.workerSessionId, "worker-current");
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

// ── CODEX ISOLATION GAP (card ed0858dc) ────────────────────────────────────────────────────────────────
// The daemon files `codex_isolation_gap_disclosed` on every codex spawn that drops a claude-side
// protection, but nudges a recipient only when the session HAS a parent — so a parentless one (every agent
// run) reached nobody. These cases pin the two filters that discriminate the real gap from ordinary noise,
// and the per-(agent, item-set) keying. See @decision ed0858dc (src/lib/fleet.ts) for what must not change.
//
// `managerSessionId: o.managerSessionId ?? o.workerSessionId ?? "run-1"` mirrors the daemon's own
// `s?.parentSessionId ?? sessionId` — so the DEFAULT factory row is the PARENTLESS shape, and a managed row
// is made by passing a managerSessionId explicitly. Pinned daemon-side (with its own negative control) in
// packages/daemon/test/codex-permission-deny-disclosure.mjs section (6).
const GAP_ITEMS = [
  { id: "settingsDirReadDeny", reason: "claude denies Read() of <LOOM_HOME>/tmp/settings/** for every role" },
  { id: "permissionDeny", reason: "this project has 2 authored permission.deny rules that codex cannot honour" },
];
const gapEv = (o = {}) => ({
  id: `ev-${++evSeq}`,
  ts: o.ts ?? new Date(evSeq).toISOString(),
  kind: o.kind ?? "codex_isolation_gap_disclosed",
  workerSessionId: o.workerSessionId ?? "run-1",
  managerSessionId: o.managerSessionId ?? o.workerSessionId ?? "run-1",
  taskId: o.taskId ?? null,
  detail: {
    items: GAP_ITEMS, agentId: "agent-codex", lineageRootId: o.workerSessionId ?? "run-1",
    itemsKey: "permissionDeny,settingsDirReadDeny", nudged: false,
    ...(o.detail ?? {}),
  },
});

check("activeCodexIsolationGapAlerts: a parentless, un-nudged disclosure surfaces an alert", () => {
  const ev = gapEv();
  const alerts = activeCodexIsolationGapAlerts([ev]);
  assert.equal(alerts.length, 1, "parentless + nudged:false ⇒ item");
  assert.equal(alerts[0].sessionId, "run-1");
  assert.equal(alerts[0].event.id, ev.id);
  assert.equal(alerts[0].dedupKey, "agent-codex:permissionDeny,settingsDirReadDeny");
});

check("activeCodexIsolationGapAlerts: a MANAGED session's row never surfaces — its manager WAS nudged", () => {
  const ev = gapEv({ workerSessionId: "w-1", managerSessionId: "mgr-1", detail: { nudged: true } });
  assert.equal(activeCodexIsolationGapAlerts([ev]).length, 0, "nudged:true ⇒ a manager is the reader, not the human");
});

// THE discrimination this surface depends on, and the reason `nudged` alone is not enough: a managed
// worker's SECOND spawn in the same lineage re-files with nudged:false (deduped, not unreachable). Keying
// on nudged alone would surface it on every subsequent spawn forever — pure noise about a gap whose
// manager was already told. Only the id equality separates the two causes of nudged:false.
check("activeCodexIsolationGapAlerts: a MANAGED row with nudged:false (lineage-deduped) is still excluded", () => {
  const ev = gapEv({ workerSessionId: "w-2", managerSessionId: "mgr-1", detail: { nudged: false } });
  assert.equal(activeCodexIsolationGapAlerts([ev]).length, 0,
    "managerSessionId !== workerSessionId ⇒ there WAS a parent; nudged:false here means already-told, not unreachable");
});

check("activeCodexIsolationGapAlerts: N disclosures from ONE agent collapse to ONE item (latest wins)", () => {
  const first = gapEv({ workerSessionId: "run-a", ts: "2026-01-01T00:00:00.000Z" });
  const second = gapEv({ workerSessionId: "run-b", ts: "2026-01-01T00:00:01.000Z" });
  const third = gapEv({ workerSessionId: "run-c", ts: "2026-01-01T00:00:02.000Z" });
  const alerts = activeCodexIsolationGapAlerts([third, first, second]); // unsorted on purpose
  assert.equal(alerts.length, 1, "same (agent, item-set) ⇒ ONE decision, however many runs disclose it");
  assert.equal(alerts[0].sessionId, "run-c", "the LATEST run is the one the item points at, regardless of array order");
});

check("activeCodexIsolationGapAlerts: a DIFFERENT item-set for the same agent is its own item", () => {
  const base = gapEv({ workerSessionId: "run-d" });
  const wider = gapEv({ workerSessionId: "run-e", detail: { itemsKey: "permissionDeny,settingsDirReadDeny,transcriptRootReadDeny" } });
  const alerts = activeCodexIsolationGapAlerts([base, wider]);
  assert.equal(alerts.length, 2, "a newly-disclosed protection is a NEW decision, not a dismissed one");
});

check("activeCodexIsolationGapAlerts: two DIFFERENT agents never share a key", () => {
  const a = gapEv({ workerSessionId: "run-f", detail: { agentId: "agent-one" } });
  const b = gapEv({ workerSessionId: "run-g", detail: { agentId: "agent-two" } });
  assert.equal(activeCodexIsolationGapAlerts([a, b]).length, 2, "one row per misconfigured agent");
});

check("activeCodexIsolationGapAlerts: a null agentId degrades to lineageRootId, never a shared key", () => {
  const a = gapEv({ workerSessionId: "run-h", detail: { agentId: null, lineageRootId: "run-h" } });
  const b = gapEv({ workerSessionId: "run-i", detail: { agentId: null, lineageRootId: "run-i" } });
  const alerts = activeCodexIsolationGapAlerts([a, b]);
  assert.equal(alerts.length, 2, "two null-agent rows must NOT collapse onto one shared key");
  assert.equal(alerts[0].dedupKey, "run-h:permissionDeny,settingsDirReadDeny");
});

check("activeCodexIsolationGapAlerts: NO liveness filter — the alert outlives the session that disclosed it", () => {
  // Unlike activeBootStuckAlerts, this helper takes no liveness predicate at all: an agent run is
  // typically already over (and archived) by the time anyone looks, and the remedy is a profile-harness
  // change, not an intervention on the session. A liveness filter would hide every real instance.
  assert.equal(activeCodexIsolationGapAlerts.length, 1, "takes events only — no liveness predicate parameter exists to pass");
  const alerts = activeCodexIsolationGapAlerts([gapEv({ workerSessionId: "run-dead" })]);
  assert.equal(alerts.length, 1, "a long-exited run's gap still surfaces");
});

// The SUPERSEDE path, and the reason the parentless/nudged test runs AFTER the latest-wins fold rather
// than inside it. Testing inside the fold would make this alert permanent: the managed row below would be
// skipped instead of winning its key, so the human item would stay up forever even once the very same
// (agent, item-set) got routed to a manager.
check("activeCodexIsolationGapAlerts: a later MANAGED disclosure for the same (agent, item-set) CLEARS the item", () => {
  const parentless = gapEv({ workerSessionId: "run-m", ts: "2026-01-01T00:00:00.000Z" });
  const managed = gapEv({ workerSessionId: "w-m", managerSessionId: "mgr-1", detail: { nudged: true }, ts: "2026-01-01T00:00:01.000Z" });
  assert.equal(activeCodexIsolationGapAlerts([parentless]).length, 1, "control: parentless alone ⇒ item");
  assert.equal(activeCodexIsolationGapAlerts([parentless, managed]).length, 0,
    "the latest word on this configuration reached a manager ⇒ the human's copy is handed off");
});

check("activeCodexIsolationGapAlerts: a later lineage-DEDUPED managed disclosure also clears it", () => {
  const parentless = gapEv({ workerSessionId: "run-n", ts: "2026-01-01T00:00:00.000Z" });
  const managed = gapEv({ workerSessionId: "w-n", managerSessionId: "mgr-1", detail: { nudged: false }, ts: "2026-01-01T00:00:01.000Z" });
  assert.equal(activeCodexIsolationGapAlerts([parentless, managed]).length, 0,
    "nudged:false on a row that HAD a parent means this lineage already told its manager — addressed either way");
});

check("activeCodexIsolationGapAlerts: order matters the right way — an OLDER managed row never clears a NEWER gap", () => {
  const managed = gapEv({ workerSessionId: "w-o", managerSessionId: "mgr-1", detail: { nudged: true }, ts: "2026-01-01T00:00:00.000Z" });
  const parentless = gapEv({ workerSessionId: "run-o", ts: "2026-01-01T00:00:01.000Z" });
  const alerts = activeCodexIsolationGapAlerts([parentless, managed]); // unsorted on purpose
  assert.equal(alerts.length, 1, "the NEWEST disclosure is unaddressed ⇒ the item stands, whatever the array order");
  assert.equal(alerts[0].sessionId, "run-o");
});

check("activeCodexIsolationGapAlerts: a row with no itemsKey is dropped defensively, never crashes", () => {
  const malformed = gapEv({ workerSessionId: "run-j", detail: { itemsKey: undefined } });
  assert.equal(activeCodexIsolationGapAlerts([malformed]).length, 0, "no item-set to key on ⇒ dropped, not surfaced");
});

check("activeCodexIsolationGapAlerts: a row with no workerSessionId cannot establish parentlessness ⇒ dropped", () => {
  const noWorker = { ...gapEv(), workerSessionId: null, managerSessionId: "run-k" };
  assert.equal(activeCodexIsolationGapAlerts([noWorker]).length, 0,
    "parentlessness needs BOTH ids present and equal — a missing one is not defaulted into either answer");
});

check("activeCodexIsolationGapAlerts: an unrelated event kind is ignored", () => {
  const other = { ...gapEv({ workerSessionId: "run-l" }), kind: "codex_unsupported_capability" };
  assert.equal(activeCodexIsolationGapAlerts([other]).length, 0,
    "the sibling capability-drop kind is a DIFFERENT signal and never surfaces here");
});

// -- ATTENTION ITEM -> OWNING PROJECT (card 5ced500b) --------------------------------------------------
// The resolver both project-scoped readers of the attention queue share: the project Overview's
// `projAttention` LIST and Mission Control's per-project `attnByProject` COUNT. The defect it fixes is
// that both used to resolve an item SOLELY through the live session feed (`WHERE archived_at IS NULL`),
// so an item whose session had archived silently dropped off the project Overview.
//
// Every case below names which of the three resolution steps it exercises, and the negative controls are
// as load-bearing as the positive ones: a resolver that answered "yes, this project" unconditionally
// would satisfy every PRESENT assertion here forever.

const PROJ = "proj-alpha";
const OTHER_PROJ = "proj-beta";

/** The two lookups a caller supplies, built from plain maps (exactly how both pages build them). */
const lookupFor = (sessions = {}, agents = {}) => ({
  sessionProjectId: (id) => sessions[id],
  agentProjectId: (id) => agents[id],
});

// -- STEP 1: an explicit projectId off the item's own source row ---------------------------------------

check("step 1 - an explicit projectId resolves with NO session lookup at all", () => {
  // A VAULT LOCK STUCK item's shape: no sessionId whatsoever, project read off detail.projectId. Before
  // this card it resolved to nothing and showed on NO project Overview, ever.
  const item = { kind: "VAULT LOCK STUCK", projectId: PROJ };
  assert.equal(resolveAttentionProjectId(item, lookupFor()), PROJ);
  assert.equal(attentionItemInProject(item, PROJ, lookupFor()), true);
});

check("step 1 - a FOREIGN projectId rejects outright even though the sid WOULD resolve here", () => {
  // THE PRECEDENCE CONTROL. The item states another project, but its session id is one this reader can
  // resolve locally. A resolver that fell through to the session lookup would wrongly claim it - which is
  // exactly the drift that would let the Overview list and the Mission Control count disagree again.
  const item = { kind: "DECISION NEEDED", projectId: OTHER_PROJ, sessionId: "sess-1" };
  const lookup = lookupFor({ "sess-1": PROJ });
  assert.equal(resolveAttentionProjectId(item, lookup), OTHER_PROJ, "the STATED project wins over the lookup");
  assert.equal(attentionItemInProject(item, PROJ, lookup), false, "so it is rejected for this project");
  assert.equal(attentionItemInProject(item, OTHER_PROJ, lookup), true, "and accepted for its own");
});

// -- STEP 2: the session id, spanning the live feed AND the archived page ------------------------------

check("step 2 - a session id resolves via the caller's lookup (the pre-existing path, unchanged)", () => {
  const item = { kind: "STUCK-BUSY", sessionId: "sess-live" };
  assert.equal(resolveAttentionProjectId(item, lookupFor({ "sess-live": PROJ })), PROJ);
});

check("step 2 - an ARCHIVED session's item resolves, which is the whole defect this card fixed", () => {
  // The caller feeds its archived page into the SAME lookup, so an id absent from the live feed but
  // present in the archive still resolves. Modelled exactly as both pages build it: one merged map.
  const item = { kind: "CODEX ISOLATION GAP", sessionId: "sess-archived" };
  const liveOnly = lookupFor({ "sess-other": PROJ });
  assert.equal(resolveAttentionProjectId(item, liveOnly), undefined,
    "NEGATIVE CONTROL / the old behaviour: with the live feed alone it resolves to nothing");
  const liveAndArchived = lookupFor({ "sess-other": PROJ, "sess-archived": PROJ });
  assert.equal(resolveAttentionProjectId(item, liveAndArchived), PROJ,
    "with the archived page folded in, the same item resolves");
});

check("step 2 - workerSessionId is the fallback when sessionId is absent (MERGE REQUEST's shape)", () => {
  const item = { kind: "MERGE REQUEST", workerSessionId: "w-1" };
  assert.equal(resolveAttentionProjectId(item, lookupFor({ "w-1": PROJ })), PROJ);
  // sessionId WINS when both are present - the non-merge kinds carry sessionId and must not be re-routed.
  const both = { kind: "MERGE REQUEST", sessionId: "s-1", workerSessionId: "w-1" };
  assert.equal(resolveAttentionProjectId(both, lookupFor({ "s-1": PROJ, "w-1": OTHER_PROJ })), PROJ);
});

check("step 2 - a CROSS-PROJECT session rejects (the cross-project negative control)", () => {
  // A sibling project's live session is resolvable by this reader's GLOBAL feed, and must come back as
  // ITS OWN project - not as a match here. Pre-card this rejected only because the project-FILTERED feed
  // never contained it; now it rejects because the resolver answers honestly.
  const item = { kind: "STUCK-BUSY", sessionId: "sess-beta" };
  const lookup = lookupFor({ "sess-beta": OTHER_PROJ });
  assert.equal(resolveAttentionProjectId(item, lookup), OTHER_PROJ);
  assert.equal(attentionItemInProject(item, PROJ, lookup), false);
});

// -- STEP 3: the agent-to-project fallback ------------------------------------------------------------

check("step 3 - agentId resolves the project when the session is unresolvable entirely", () => {
  // A CODEX ISOLATION GAP whose run session has aged past the caller's bounded archive page. Agents are
  // project-scoped in Loom, so the agent id is still a sound key - and the agent's profile harness is the
  // very thing the human must edit.
  const item = { kind: "CODEX ISOLATION GAP", sessionId: "sess-gone", agentId: "agent-7" };
  assert.equal(resolveAttentionProjectId(item, lookupFor({}, { "agent-7": PROJ })), PROJ);
});

check("step 3 - the session lookup WINS over agentId when it can answer", () => {
  const item = { kind: "CODEX ISOLATION GAP", sessionId: "sess-known", agentId: "agent-7" };
  const lookup = lookupFor({ "sess-known": PROJ }, { "agent-7": OTHER_PROJ });
  assert.equal(resolveAttentionProjectId(item, lookup), PROJ, "step 2 answers first, so step 3 is not consulted");
});

check("step 3 - a FOREIGN agent rejects, so the fallback cannot launder a cross-project item in", () => {
  const item = { kind: "CODEX ISOLATION GAP", sessionId: "sess-gone", agentId: "agent-beta" };
  const lookup = lookupFor({}, { "agent-beta": OTHER_PROJ });
  assert.equal(resolveAttentionProjectId(item, lookup), OTHER_PROJ);
  assert.equal(attentionItemInProject(item, PROJ, lookup), false);
});

check("step 3 - omitting the agent lookup SKIPS the step rather than throwing (Mission Control's case)", () => {
  // Mission Control fetches no agents, so it passes no agentProjectId at all. That must degrade to
  // undefined, never crash the page's whole attention count.
  const item = { kind: "CODEX ISOLATION GAP", sessionId: "sess-gone", agentId: "agent-7" };
  assert.equal(resolveAttentionProjectId(item, { sessionProjectId: () => undefined }), undefined);
  assert.equal(resolveAttentionProjectId(item, {}), undefined, "no lookups at all is also safe");
  assert.equal(resolveAttentionProjectId(item), undefined, "and the whole argument may be omitted");
});

// -- THE UNRESOLVABLE CASE + the disclosed bound -------------------------------------------------------

check("an item that matches no step resolves to undefined and belongs to no project", () => {
  // The disclosed bound: a codex-gap row with a null agentId whose session has rolled past every bounded
  // archive page. Deliberately NOT closed (that would need a per-item archivedSessionById fetch), so this
  // asserts the honest answer rather than a guess.
  const item = { kind: "CODEX ISOLATION GAP", sessionId: "sess-gone", agentId: null };
  assert.equal(resolveAttentionProjectId(item, lookupFor()), undefined);
  assert.equal(attentionItemInProject(item, PROJ, lookupFor()), false);
});

check("an item with no project key of any kind resolves to undefined", () => {
  assert.equal(resolveAttentionProjectId({ kind: "RATE-LIMITED" }, lookupFor({ x: PROJ })), undefined,
    "no projectId, no sessionId, no workerSessionId, no agentId => nothing to resolve from");
});

check("attentionItemInProject rejects a null/undefined active project rather than matching anything", () => {
  // The Overview renders before `useActiveProject` resolves; a null projectId must not match an item
  // whose own resolution also came back undefined (undefined === undefined would otherwise be TRUE).
  const unresolvable = { kind: "CODEX ISOLATION GAP", sessionId: "sess-gone" };
  assert.equal(attentionItemInProject(unresolvable, null, lookupFor()), false);
  assert.equal(attentionItemInProject(unresolvable, undefined, lookupFor()), false);
  assert.equal(attentionItemInProject({ projectId: PROJ }, null, lookupFor()), false);
});

// -- EMPTY-STRING HYGIENE -----------------------------------------------------------------------------

check("an empty-string projectId is treated as absent, not as a project named empty", () => {
  // `vault_index_lock_stale` is filed `managerSessionId:""` daemon-global, so an empty string is a shape
  // that genuinely reaches this code - it must fall through to the session lookup, never match a project.
  const item = { kind: "VAULT LOCK STUCK", projectId: "", sessionId: "sess-1" };
  assert.equal(resolveAttentionProjectId(item, lookupFor({ "sess-1": PROJ })), PROJ,
    "the empty projectId is skipped and step 2 answers");
  assert.equal(attentionItemInProject({ projectId: "" }, "", lookupFor()), false,
    "and an empty active project never matches, even against an empty item");
});

console.log(`\n${pass} passed`);
