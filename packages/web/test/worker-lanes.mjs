// Hermetic unit test for the manager's worker lane rail — src/lib/workerLanes.ts, card dd5c8724.
// No daemon, no browser: it imports the real derivations and asserts on plain objects shaped like the
// `["allSessions"]` feed, a manager's `["orchEvents", id]` stream and the `["gates-active"]` snapshot.
//
// Run it with: node --experimental-strip-types packages/web/test/worker-lanes.mjs
import assert from "node:assert/strict";
import { register } from "node:module";

// workerLanes.ts imports ./cardWorker extensionless (bundler style), which Node's own resolver cannot
// follow, so the import below is DYNAMIC: a static one would hoist above `register()`.
register("./_tsxLoaderHook.mjs", import.meta.url);

const {
  LANE_STEPS, buildWorkerLanes, finishedRecently, formatElapsed, formatGateTimer, latestWorkerReport, managerWorkers,
  workerLaneCtx, workerLaneGate, workerLaneStatus, workerLaneStep,
} = await import("../src/lib/workerLanes.ts");

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();
const W = (id, extra = {}) => ({ id, processState: "live", busy: false, createdAt: ago(600), role: "worker", parentSessionId: "mgr", taskId: `t-${id}`, ...extra });
let seq = 0;
const E = (kind, workerSessionId, extra = {}) => ({
  id: `e${seq++}`, ts: ago(300 - seq), managerSessionId: "mgr", workerSessionId, taskId: `t-${workerSessionId}`, kind, ...extra,
});
const report = (w, status, more = {}, ts) => E("worker_report", w, { ...(ts ? { ts } : null), detail: { status, summary: `${status} summary`, ...more } });
const ctx = (report, reviewPending = false) => ({ report, reviewPending, now: NOW });

// ── workerLaneStep: the five steps, each reached by its own rule ─────────────────────────────────

check("a fresh worker with no turn and no report is Dispatched", () => {
  assert.equal(workerLaneStep(W("a"), ctx(null)), "dispatched");
  assert.equal(workerLaneStep(W("a", { processState: "starting" }), ctx(null)), "dispatched");
});

check("a busy worker, or one that has run a turn, is Working", () => {
  assert.equal(workerLaneStep(W("a", { busy: true }), ctx(null)), "working");
  assert.equal(workerLaneStep(W("a", { turnSeq: 3 }), ctx(null)), "working");
  assert.equal(workerLaneStep(W("a", { ctxTurns: 1 }), ctx(null)), "working");
});

check("a progress or blocked report keeps the worker on Working (only `done` is Reported)", () => {
  assert.equal(workerLaneStep(W("a"), ctx({ status: "progress" })), "working");
  assert.equal(workerLaneStep(W("a"), ctx({ status: "blocked" })), "working");
});

check("a done report on an idle worker is Reported; a turn after it is Working again", () => {
  assert.equal(workerLaneStep(W("a"), ctx({ status: "done" })), "reported");
  assert.equal(workerLaneStep(W("a", { busy: true }), ctx({ status: "done" })), "working");
});

check("a pending merge request is Review, whatever the report says", () => {
  assert.equal(workerLaneStep(W("a"), ctx({ status: "done" }, true)), "review");
  assert.equal(workerLaneStep(W("a", { busy: true }), ctx(null, true)), "review");
});

check("a running merge op is Merging and beats a still-pending review", () => {
  const pm = { opId: "o", state: "running", startedAt: ago(30), gatePhase: "running" };
  assert.equal(workerLaneStep(W("a", { pendingMerge: pm }), ctx({ status: "done" }, true)), "merging");
  assert.equal(workerLaneStep(W("a", { pendingMerge: { ...pm, gatePhase: "queued" } }), ctx(null, true)), "merging");
  // A SETTLED op (the retained view) is not merging any more.
  assert.equal(workerLaneStep(W("a", { pendingMerge: { ...pm, state: "done", outcome: "rejected" } }), ctx({ status: "done" })), "reported");
});

check("the track is exactly the five steps, in order", () => {
  assert.deepEqual([...LANE_STEPS], ["dispatched", "working", "reported", "review", "merging"]);
});

// ── workerLaneStatus: the pill and its precedence ───────────────────────────────────────────────

check("a session that is not running reads as its processState, muted, before anything else", () => {
  const s = workerLaneStatus(W("a", { processState: "exited", rateLimitedUntil: ago(-600) }), ctx({ status: "blocked" }, true));
  assert.deepEqual([s.key, s.tone, s.label], ["exited", "muted", "exited"]);
  assert.equal(workerLaneStatus(W("a", { processState: "none" }), ctx(null)).label, "none");
});

check("rate-limited only while the limit is in the future", () => {
  assert.equal(workerLaneStatus(W("a", { rateLimitedUntil: ago(-60) }), ctx(null, true)).key, "rate-limited");
  assert.equal(workerLaneStatus(W("a", { rateLimitedUntil: ago(60) }), ctx(null)).key, "idle");
});

check("merging (or merge queued) beats awaiting review", () => {
  const pm = { opId: "o", state: "running", startedAt: ago(30), gatePhase: "running" };
  assert.equal(workerLaneStatus(W("a", { pendingMerge: pm }), ctx(null, true)).key, "merging");
  const q = workerLaneStatus(W("a", { pendingMerge: { ...pm, gatePhase: "queued" } }), ctx(null, true));
  assert.deepEqual([q.key, q.tone], ["merge-queued", "muted"]);
});

check("awaiting review › blocked › working › idle", () => {
  assert.equal(workerLaneStatus(W("a"), ctx({ status: "blocked" }, true)).key, "review");
  assert.equal(workerLaneStatus(W("a"), ctx({ status: "blocked" })).key, "blocked");
  assert.equal(workerLaneStatus(W("a", { busy: true }), ctx({ status: "blocked" })).key, "working",
    "a turn running since the blocked report means the block was answered");
  assert.equal(workerLaneStatus(W("a"), ctx({ status: "done" })).key, "idle");
  assert.equal(workerLaneStatus(W("a", { processState: "starting" }), ctx(null)).key, "starting");
});

check("tone semantics: amber only where someone must act", () => {
  assert.equal(workerLaneStatus(W("a"), ctx(null, true)).tone, "attn");
  assert.equal(workerLaneStatus(W("a"), ctx({ status: "blocked" })).tone, "attn");
  assert.equal(workerLaneStatus(W("a", { busy: true }), ctx(null)).tone, "work");
  assert.equal(workerLaneStatus(W("a"), ctx(null)).tone, "live");
});

// ── latestWorkerReport ─────────────────────────────────────────────────────────────────────────

check("the newest report for THIS worker wins; another worker's is ignored", () => {
  const evs = [report("a", "progress", {}, ago(100)), report("a", "blocked", { needs: "  which tie-break?  " }, ago(50)), report("b", "done", {}, ago(10))];
  const r = latestWorkerReport(evs, "a");
  assert.deepEqual([r.status, r.needs, r.summary], ["blocked", "which tie-break?", "blocked summary"]);
  assert.equal(latestWorkerReport(evs, "c"), null);
  assert.equal(latestWorkerReport(undefined, "a"), null);
});

check("a report with a blank summary reads as null, never an empty line", () => {
  const r = latestWorkerReport([E("worker_report", "a", { detail: { status: "done", summary: "   " } })], "a");
  assert.equal(r.summary, null);
});

// ── gates ──────────────────────────────────────────────────────────────────────────────────────

const gate = (sessionId, extra = {}) => ({ id: "g", gateType: "worker", phase: "running", sessionId, since: ago(252), landingCheckOnly: false, distImporterCheckOnly: false, ...extra });

check("the worker's own self-check is shown; a landing check or dist-importer advisory is not", () => {
  assert.deepEqual(workerLaneGate(W("a"), [gate("a")]), { kind: "self-check", phase: "running", since: ago(252) });
  assert.equal(workerLaneGate(W("a"), [gate("a", { landingCheckOnly: true })]), null);
  assert.equal(workerLaneGate(W("a"), [gate("a", { distImporterCheckOnly: true })]), null);
  assert.equal(workerLaneGate(W("a"), [gate("b")]), null);
  assert.equal(workerLaneGate(W("a"), [gate("a", { gateType: "merge" })]), null, "a merge gate reads off pendingMerge, not the snapshot");
});

check("a running merge op wins over a self-check", () => {
  const pm = { opId: "o", state: "running", startedAt: ago(468), gatePhase: "running" };
  assert.deepEqual(workerLaneGate(W("a", { pendingMerge: pm }), [gate("a")]), { kind: "merge", phase: "running", since: ago(468) });
  assert.equal(workerLaneGate(W("a", { pendingMerge: { ...pm, gatePhase: "queued" } }), []).phase, "queued");
});

check("formatGateTimer is M:SS and never negative", () => {
  assert.equal(formatGateTimer(ago(468), NOW), "7:48");
  assert.equal(formatGateTimer(ago(-5), NOW), "0:00");
  assert.equal(formatGateTimer("nope", NOW), "0:00");
});

// ── ctx ────────────────────────────────────────────────────────────────────────────────────────

check("context: unmeasured is null; a measured reading is a whole percent with a warn flag", () => {
  assert.equal(workerLaneCtx({ ctxInputTokens: 0 }), null);
  assert.equal(workerLaneCtx({}), null);
  const low = workerLaneCtx({ ctxInputTokens: 20_000, model: "claude-sonnet-4-5" });
  assert.ok(low && low.pct > 0 && low.warn === false);
  const high = workerLaneCtx({ ctxInputTokens: 10_000_000, model: "claude-sonnet-4-5" });
  assert.ok(high && high.pct === 100 && high.warn === true);
});

// ── managerWorkers + buildWorkerLanes ──────────────────────────────────────────────────────────

check("only this manager's unarchived workers are lanes", () => {
  const rows = [W("a"), W("b", { parentSessionId: "other" }), W("c", { role: "manager" }), W("d", { archivedAt: ago(5) }), W("e", { processState: "exited" })];
  assert.deepEqual(managerWorkers(rows, "mgr").map((w) => w.id), ["a", "e"]);
  assert.deepEqual(managerWorkers(undefined, "mgr"), []);
});

check("lanes sort the ones needing a look first, oldest dispatch breaking ties", () => {
  const workers = [
    W("idle", { createdAt: ago(900) }),
    W("busy2", { busy: true, createdAt: ago(100) }),
    W("busy1", { busy: true, createdAt: ago(800) }),
    W("blocked"),
    W("review"),
    W("gone", { processState: "exited" }),
  ];
  const evs = [report("blocked", "blocked", { needs: "x" }), E("merge_request", "review")];
  const lanes = buildWorkerLanes(workers, evs, [], NOW);
  assert.deepEqual(lanes.map((l) => l.worker.id), ["review", "blocked", "busy1", "busy2", "idle", "gone"]);
  const review = lanes[0];
  assert.deepEqual([review.step, review.reviewPending, review.status.label], ["review", true, "awaiting review"]);
});

check("a merge request filed for a DIFFERENT worker of the same card is not this worker's review", () => {
  const evs = [E("merge_request", "old", { taskId: "t-a" })];
  const [lane] = buildWorkerLanes([W("a")], evs, [], NOW);
  assert.equal(lane.reviewPending, false);
});

check("merge_done after the request retires the review", () => {
  const evs = [E("merge_request", "a"), E("merge_done", "a")];
  const [lane] = buildWorkerLanes([W("a")], evs, [], NOW);
  assert.equal(lane.reviewPending, false);
});

// ── finishedRecently ───────────────────────────────────────────────────────────────────────────

check("finished: latest finishing event per worker inside the hour, newest first, lanes skipped", () => {
  const evs = [
    E("merge_done", "k", { ts: ago(18 * 60) }),
    E("stop_worker", "h", { ts: ago(47 * 60) }),
    E("worker_exited_without_report", "x", { ts: ago(5 * 60) }),
    E("stop_worker", "old", { ts: ago(61 * 60) }),
    E("merge_done", "live", { ts: ago(60) }),
    E("worker_report", "z", { ts: ago(60), detail: { status: "done" } }),
  ];
  const f = finishedRecently(evs, new Set(["live"]), NOW);
  assert.deepEqual(f.map((x) => [x.workerSessionId, x.outcome]), [["x", "exited"], ["k", "merged"], ["h", "stopped"]]);
  assert.equal(f[1].taskId, "t-k");
});

check("finished: a stop then a merge for one worker reads as the later one", () => {
  const evs = [E("stop_worker", "k", { ts: ago(600) }), E("merge_done", "k", { ts: ago(300) })];
  assert.deepEqual(finishedRecently(evs, new Set(), NOW).map((x) => x.outcome), ["merged"]);
});

// ── formatElapsed ──────────────────────────────────────────────────────────────────────────────

check("formatElapsed: s, m, h mm, d h; unknown or future is null", () => {
  assert.equal(formatElapsed(ago(40), NOW), "40s");
  assert.equal(formatElapsed(ago(9 * 60 + 5), NOW), "9m");
  assert.equal(formatElapsed(ago(72 * 60), NOW), "1h 12m");
  assert.equal(formatElapsed(ago(60 * 60 + 5 * 60), NOW), "1h 05m");
  assert.equal(formatElapsed(ago(76 * 3600), NOW), "3d 4h");
  assert.equal(formatElapsed(null, NOW), null);
  assert.equal(formatElapsed("nope", NOW), null);
  assert.equal(formatElapsed(ago(-30), NOW), null);
});

console.log(`\n${pass} checks passed`);
