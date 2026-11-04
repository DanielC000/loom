import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Session usage telemetry — the DATA layer (epic c9924bcd, card A): the append-only `session_usage_samples`
// time-series + its insert/aggregate/prune helpers + the read route. HERMETIC + CLAUDE-FREE + NETWORK-FREE:
// a temp DB seeded with per-interval DELTA samples across two projects/two agents at known timestamps, the
// REAL db.aggregateSessionUsage + db.pruneUsageSamples exercised directly, plus the REAL buildServer driven
// by app.inject for GET /api/usage/sessions/history (clamp + echo).
//
// Each row is a per-interval DELTA (additive) — so a windowed/bucketed sum is a plain SUM, no monotonicity
// math. Covers the card's DoD:
//   • TOTALS — grand sums over the window (sample count + tokens + costUsd).
//   • byProject / byAgent — GROUP BY breakdowns joined to project/agent names.
//   • byDay — GROUP BY substr(ts,1,10) buckets, ascending; same-day deltas accumulate into one bucket.
//   • bySession + cacheHitRatio (card 0dd60be4, rec#1 follow-up) — the per-SESSION breakdown (ranked by
//     cost, role-attributed via a LEFT JOIN sessions so a gone/never-recorded session still reports) and
//     the prompt-cache hit-ratio carried on EVERY breakdown row (totals/byProject/byAgent/byDay/bySession).
//     See test/cache-hit-ratio.mjs for the pure-function unit coverage (warm/broken-prefix/divide-by-zero
//     edge cases); this file covers the DB-layer + wire integration of the SAME guard.
//   • projectId FILTER — scoping to one project narrows totals + every breakdown (incl. bySession); "all"/
//     omitted spans all.
//   • EMPTY case — a project with no samples → zeroed totals + empty breakdowns (incl. cacheHitRatio: null).
//   • SINCE cutoff — a row older than the cutoff is excluded; widening re-includes it.
//   • pruneUsageSamples — drops rows older than a cutoff (and is a no-op the second time).
//   • ROUTE — GET /api/usage/sessions/history clamps a bad/missing `since` to 30d, echoes since+filter,
//     and carries bySession + cacheHitRatio over the wire.
// Run: 1) build (turbo builds shared first), 2) node test/usage-samples.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-usamp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45403";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

const now = new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const dayOf = (iso) => iso.slice(0, 10);

try {
  const db = new Db(path.join(tmpHome, "usamp.db"));
  // Two active projects + an empty one; two agents in pA, one in pB.
  db.insertProject({ id: "pA", name: "Alpha", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Beta", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pEmpty", name: "Empty", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  const mkAgent = (id, projectId, name) => db.insertAgent({ id, projectId, name, startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });
  mkAgent("aA1", "pA", "Analyst One");
  mkAgent("aA2", "pA", "Analyst Two");
  mkAgent("aB1", "pB", "Beta Bot");

  // Distinct calendar days (UTC ISO has no DST, so whole-DAY offsets land on distinct dates). Captured
  // ONCE and reused so same-day samples share a byte-identical ts (and thus byDay bucket).
  const ts2 = isoAgo(2 * DAY);     // day D2 — s1, s2 (pA/aA1) + s4 (pB/aB1)
  const ts3 = isoAgo(3 * DAY);     // day D3 — s3 (pA/aA2)
  const ts5 = isoAgo(5 * DAY);     // day D5 — s5 (pB/aB1)
  const tsOld = isoAgo(100 * DAY); // far past — excluded by 30d window; prunable
  const [d2, d3, d5] = [dayOf(ts2), dayOf(ts3), dayOf(ts5)];

  // Each sample is a per-interval DELTA (NOT cumulative). seed(id, project, agent, ts, [in,out,cc,cr,cost]).
  const seed = (id, projectId, agentId, ts, [i, o, cc, cr, cost], model = "claude-opus-4-8") =>
    db.insertUsageSample({
      id, sessionId: `sess-${id}`, projectId, agentId, model, ts,
      inputTokens: i, outputTokens: o, cacheCreationTokens: cc, cacheReadTokens: cr, costUsd: cost,
    });

  seed("s1", "pA", "aA1", ts2, [100, 40, 10, 5, 0.10]);
  seed("s2", "pA", "aA1", ts2, [50, 20, 5, 2, 0.05]); // same session/day continuation → deltas accumulate
  seed("s3", "pA", "aA2", ts3, [200, 70, 20, 8, 0.20]);
  seed("s4", "pB", "aB1", ts2, [300, 90, 30, 12, 0.30]);
  seed("s5", "pB", "aB1", ts5, [400, 100, 40, 16, 0.40]);
  seed("sOld", "pA", "aA1", tsOld, [9999, 8888, 7777, 6666, 99]); // outside 30d; prune target

  // bySession/cacheHitRatio fixtures (card 0dd60be4): a `sessions` row for each of sess-s1/s3/s4 so the
  // bySession LEFT JOIN can attribute a role; sess-s2/s5 deliberately get NO row, to prove a gone/never-
  // recorded session still reports its usage (role: null) instead of vanishing from the breakdown.
  const mkSession = (id, projectId, agentId, role) => db.insertSession({
    id, projectId, agentId, engineSessionId: null, title: null, cwd: tmpHome,
    processState: "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
  mkSession("sess-s1", "pA", "aA1", "manager");
  mkSession("sess-s3", "pA", "aA2", "worker");
  mkSession("sess-s4", "pB", "aB1", "manager");

  // =====================================================================================================
  // 1) TOTALS over the 30-day window — all projects. sOld (100d) excluded.
  // =====================================================================================================
  const since30 = isoAgo(30 * DAY);
  const all = db.aggregateSessionUsage({ sinceIso: since30 });
  check("1 totals.samples counts the 5 in-window samples", all.totals.samples === 5);
  check("1 totals.inputTokens summed (100+50+200+300+400=1050)", all.totals.inputTokens === 1050);
  check("1 totals.outputTokens summed (40+20+70+90+100=320)", all.totals.outputTokens === 320);
  check("1 totals.cacheCreationTokens summed (10+5+20+30+40=105)", all.totals.cacheCreationTokens === 105);
  check("1 totals.cacheReadTokens summed (5+2+8+12+16=43)", all.totals.cacheReadTokens === 43);
  check("1 totals.costUsd summed (0.10+0.05+0.20+0.30+0.40=1.05)", approx(all.totals.costUsd, 1.05));

  // =====================================================================================================
  // 2) byProject / byAgent breakdowns (joined to names).
  // =====================================================================================================
  const proj = Object.fromEntries(all.byProject.map((r) => [r.projectId, r]));
  check("2 byProject covers exactly the two active projects", all.byProject.length === 2 && !!proj.pA && !!proj.pB);
  check("2 byProject[pA] name + samples(3) + input(350) + output(130) + cc(35) + cr(15) + cost(0.35)",
    proj.pA.projectName === "Alpha" && proj.pA.samples === 3 && proj.pA.inputTokens === 350 &&
    proj.pA.outputTokens === 130 && proj.pA.cacheCreationTokens === 35 && proj.pA.cacheReadTokens === 15 && approx(proj.pA.costUsd, 0.35));
  check("2 byProject[pB] name + samples(2) + input(700) + cost(0.70)",
    proj.pB.projectName === "Beta" && proj.pB.samples === 2 && proj.pB.inputTokens === 700 && approx(proj.pB.costUsd, 0.70));

  const ag = Object.fromEntries(all.byAgent.map((r) => [r.agentId, r]));
  check("2 byAgent covers exactly the three agents that sampled", all.byAgent.length === 3 && !!ag.aA1 && !!ag.aA2 && !!ag.aB1);
  check("2 byAgent[aA1] name + samples(2, sOld excluded by cutoff) + input(150) + cost(0.15)",
    ag.aA1.agentName === "Analyst One" && ag.aA1.samples === 2 && ag.aA1.inputTokens === 150 && approx(ag.aA1.costUsd, 0.15));
  check("2 byAgent[aA2] name + samples(1) + input(200)", ag.aA2.agentName === "Analyst Two" && ag.aA2.samples === 1 && ag.aA2.inputTokens === 200);
  check("2 byAgent[aB1] name + samples(2) + input(700) + cost(0.70)",
    ag.aB1.agentName === "Beta Bot" && ag.aB1.samples === 2 && ag.aB1.inputTokens === 700 && approx(ag.aB1.costUsd, 0.70));
  // byAgent now carries the agent's OWNING project (projectId/projectName) to disambiguate identically-
  // named agents across projects in the "all" scope.
  check("2 byAgent[aA1] owning project (pA / Alpha)", ag.aA1.projectId === "pA" && ag.aA1.projectName === "Alpha");
  check("2 byAgent[aA2] owning project (pA / Alpha)", ag.aA2.projectId === "pA" && ag.aA2.projectName === "Alpha");
  check("2 byAgent[aB1] owning project (pB / Beta)", ag.aB1.projectId === "pB" && ag.aB1.projectName === "Beta");

  // =====================================================================================================
  // 2b) cacheHitRatio (card 0dd60be4) — carried on EVERY breakdown row (totals/byProject/byAgent), each
  //     scored against ITS OWN cacheRead/cacheCreation/input sums.
  // =====================================================================================================
  check("2b totals.cacheHitRatio = 43/(43+105+1050)", approx(all.totals.cacheHitRatio, 43 / (43 + 105 + 1050)));
  check("2b byProject[pA].cacheHitRatio = 15/(15+35+350)", approx(proj.pA.cacheHitRatio, 15 / (15 + 35 + 350)));
  check("2b byProject[pB].cacheHitRatio = 28/(28+70+700)", approx(proj.pB.cacheHitRatio, 28 / (28 + 70 + 700)));
  check("2b byAgent[aA1].cacheHitRatio = 7/(7+15+150)", approx(ag.aA1.cacheHitRatio, 7 / (7 + 15 + 150)));

  // =====================================================================================================
  // 2c) bySession (card 0dd60be4) — the per-SESSION breakdown the cache hit ratio is actually meaningful
  //     at (one session = one fixed startup prefix). Ranked by costUsd desc (same as byProject/byAgent).
  //     sess-s1/s3/s4 have a real `sessions` row (role attributed); sess-s2/s5 deliberately don't — a
  //     gone/never-recorded session STILL reports its usage via the LEFT JOIN, with role: null.
  // =====================================================================================================
  check("2c bySession covers exactly the 5 in-window sessions", all.bySession.length === 5);
  check("2c bySession ordered by costUsd desc (s5 0.40, s4 0.30, s3 0.20, s1 0.10, s2 0.05)",
    all.bySession.map((r) => r.sessionId).join(",") === "sess-s5,sess-s4,sess-s3,sess-s1,sess-s2");
  const sess = Object.fromEntries(all.bySession.map((r) => [r.sessionId, r]));
  check("2c bySession[sess-s1] role manager (a real sessions row) + samples/tokens + ratio 5/115",
    sess["sess-s1"].role === "manager" && sess["sess-s1"].agentId === "aA1" && sess["sess-s1"].projectId === "pA" &&
    sess["sess-s1"].samples === 1 && sess["sess-s1"].inputTokens === 100 &&
    approx(sess["sess-s1"].cacheHitRatio, 5 / 115));
  check("2c bySession[sess-s3] role worker + ratio 8/228", sess["sess-s3"].role === "worker" && approx(sess["sess-s3"].cacheHitRatio, 8 / 228));
  check("2c bySession[sess-s4] role manager + ratio 12/342", sess["sess-s4"].role === "manager" && approx(sess["sess-s4"].cacheHitRatio, 12 / 342));
  check("2c bySession[sess-s2] NO sessions row ⇒ role null, usage still reported (not dropped)",
    sess["sess-s2"].role === null && sess["sess-s2"].inputTokens === 50 && approx(sess["sess-s2"].cacheHitRatio, 2 / 57));
  check("2c bySession[sess-s5] NO sessions row ⇒ role null, usage still reported (not dropped)",
    sess["sess-s5"].role === null && sess["sess-s5"].inputTokens === 400 && approx(sess["sess-s5"].cacheHitRatio, 16 / 456));

  // =====================================================================================================
  // 3) byDay buckets — GROUP BY substr(ts,1,10), ascending; same-day deltas accumulate into one bucket.
  // =====================================================================================================
  check("3 byDay has 3 buckets ordered ASCending (D5 < D3 < D2)",
    all.byDay.length === 3 && all.byDay[0].day === d5 && all.byDay[1].day === d3 && all.byDay[2].day === d2);
  const byDay = Object.fromEntries(all.byDay.map((r) => [r.day, r]));
  check("3 byDay[D2] accumulates s1+s2+s4 (samples 3, input 450, output 150, cost 0.45)",
    byDay[d2].samples === 3 && byDay[d2].inputTokens === 450 && byDay[d2].outputTokens === 150 && approx(byDay[d2].costUsd, 0.45));
  check("3 byDay[D3] = s3 only (samples 1, input 200, cost 0.20)",
    byDay[d3].samples === 1 && byDay[d3].inputTokens === 200 && approx(byDay[d3].costUsd, 0.20));
  check("3 byDay[D5] = s5 only (samples 1, input 400, cost 0.40)",
    byDay[d5].samples === 1 && byDay[d5].inputTokens === 400 && approx(byDay[d5].costUsd, 0.40));

  // =====================================================================================================
  // 4) projectId FILTER — scoping to pA narrows totals + every breakdown.
  // =====================================================================================================
  const onlyA = db.aggregateSessionUsage({ sinceIso: since30, projectId: "pA" });
  check("4 filter=pA totals = pA only (samples 3, input 350, cost 0.35)",
    onlyA.totals.samples === 3 && onlyA.totals.inputTokens === 350 && approx(onlyA.totals.costUsd, 0.35));
  check("4 filter=pA byProject is just pA", onlyA.byProject.length === 1 && onlyA.byProject[0].projectId === "pA");
  check("4 filter=pA byAgent excludes pB's agent (only aA1,aA2)",
    onlyA.byAgent.length === 2 && onlyA.byAgent.every((r) => r.agentId === "aA1" || r.agentId === "aA2"));
  check("4 filter=pA byDay is D3 + D2 only (s4 on D2 belongs to pB, excluded)",
    onlyA.byDay.length === 2 && onlyA.byDay[0].day === d3 && onlyA.byDay[1].day === d2 &&
    onlyA.byDay.find((r) => r.day === d2).inputTokens === 150);
  check("4 filter=pA bySession excludes pB's sessions (sess-s1/s2/s3 only)",
    onlyA.bySession.length === 3 && onlyA.bySession.every((r) => r.projectId === "pA"));
  // "all" is treated identically to omitted (spans every project).
  const allKeyword = db.aggregateSessionUsage({ sinceIso: since30, projectId: "all" });
  check("4 projectId=\"all\" spans every project (same as omitted)", allKeyword.totals.samples === 5 && allKeyword.byProject.length === 2);

  // =====================================================================================================
  // 5) EMPTY case — a project with no samples → zeroed totals + empty breakdowns.
  // =====================================================================================================
  const empty = db.aggregateSessionUsage({ sinceIso: since30, projectId: "pEmpty" });
  check("5 empty project → totals all zero", empty.totals.samples === 0 && empty.totals.inputTokens === 0 && empty.totals.costUsd === 0);
  check("5 empty project → empty byProject + byAgent + byDay + bySession", empty.byProject.length === 0 && empty.byAgent.length === 0 && empty.byDay.length === 0 && empty.bySession.length === 0);
  // DIVIDE-BY-ZERO GUARD (card 0dd60be4) — a totals row with zero cacheRead+cacheCreation+input (no
  // samples at all) reports cacheHitRatio: null, never 0/NaN — a real end-to-end read of the same guard
  // cache-hit-ratio.mjs unit-tests directly against the pure function.
  check("5 empty project → totals.cacheHitRatio is null (nothing to divide by), not 0/NaN",
    empty.totals.cacheHitRatio === null);

  // =====================================================================================================
  // 6) SINCE cutoff — older rows excluded; widening re-includes them.
  // =====================================================================================================
  const tight = db.aggregateSessionUsage({ sinceIso: isoAgo(4 * DAY) });
  check("6 a 4-day window excludes s5 (5d) + sOld (samples 4, input 100+50+200+300=650)",
    tight.totals.samples === 4 && tight.totals.inputTokens === 650);
  const wide = db.aggregateSessionUsage({ sinceIso: isoAgo(200 * DAY) });
  check("6 widening to 200d re-includes sOld (samples 6, input 1050+9999=11049)",
    wide.totals.samples === 6 && wide.totals.inputTokens === 11049);
  const veryTight = db.aggregateSessionUsage({ sinceIso: isoAgo(1) });
  check("6 a now-ish cutoff excludes every sample (samples 0)", veryTight.totals.samples === 0 && veryTight.byDay.length === 0);
  check("6 a now-ish cutoff → totals.cacheHitRatio null + bySession empty (nothing to score)",
    veryTight.totals.cacheHitRatio === null && veryTight.bySession.length === 0);

  // =====================================================================================================
  // 7) pruneUsageSamples — drops rows older than the cutoff; a second prune is a no-op.
  // =====================================================================================================
  const removed = db.pruneUsageSamples(isoAgo(50 * DAY));
  check("7 prune(<50d ago) removes the single old row (sOld)", removed === 1);
  const afterPrune = db.aggregateSessionUsage({ sinceIso: isoAgo(200 * DAY) });
  check("7 after prune, the wide window no longer sees sOld (samples 5, input 1050)",
    afterPrune.totals.samples === 5 && afterPrune.totals.inputTokens === 1050);
  check("7 a second prune at the same cutoff removes nothing", db.pruneUsageSamples(isoAgo(50 * DAY)) === 0);

  // =====================================================================================================
  // 8) ROUTE — GET /api/usage/sessions/history: clamp a missing/bad `since` to 30d, echo since + filter.
  // =====================================================================================================
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const get = (q) => app.inject({ method: "GET", url: `/api/usage/sessions/history${q}` });

  const r30 = await get(`?since=${encodeURIComponent(since30)}`);
  const b30 = r30.json();
  check("8 route 200 + echoes since + projectId:null (all) + the 5-sample totals",
    r30.statusCode === 200 && b30.since === since30 && b30.projectId === null &&
    b30.totals.samples === 5 && b30.totals.inputTokens === 1050);
  check("8 route returns byProject + byAgent + byDay breakdowns", b30.byProject.length === 2 && b30.byAgent.length === 3 && b30.byDay.length === 3);
  check("8 route returns bySession (5 rows) with cacheHitRatio on every row (incl. totals)",
    b30.bySession.length === 5 && typeof b30.totals.cacheHitRatio === "number" &&
    b30.bySession.every((r) => r.cacheHitRatio === null || typeof r.cacheHitRatio === "number"));
  const b30Sess1 = b30.bySession.find((r) => r.sessionId === "sess-s1");
  check("8 route bySession[sess-s1] carries role manager + matching ratio (5/115) over the wire",
    b30Sess1?.role === "manager" && approx(b30Sess1.cacheHitRatio, 5 / 115));

  const rFilter = await get(`?since=${encodeURIComponent(since30)}&projectId=pA`);
  const bFilter = rFilter.json();
  check("8 route projectId=pA echoed + scoped totals (samples 3)", bFilter.projectId === "pA" && bFilter.totals.samples === 3);

  // Missing `since` → clamped to ~30d ago (echoed since within ±1min of 30d).
  const rMissing = await get("");
  const bMissing = rMissing.json();
  const echoedAgoMs = Date.now() - Date.parse(bMissing.since);
  check("8 missing since → clamped to ~30d window (echoed since ≈ 30d ago)",
    rMissing.statusCode === 200 && Math.abs(echoedAgoMs - 30 * DAY) < 60_000);

  // Unparseable `since` → same default clamp (not NaN/crash).
  const rBad = await get("?since=not-a-date");
  check("8 unparseable since → 200 + clamped (not a crash)", rBad.statusCode === 200 && Number.isFinite(Date.parse(rBad.json().since)));

  // Older-than-1yr `since` → floored at 1yr ago (never an unbounded scan).
  const rAncient = await get(`?since=${encodeURIComponent(isoAgo(3 * 365 * DAY))}`);
  const ancientAgoMs = Date.now() - Date.parse(rAncient.json().since);
  check("8 since older than 1yr → floored at ~1yr ago", Math.abs(ancientAgoMs - 365 * DAY) < 60_000);

  // =====================================================================================================
  // 9) byTask / orchestrationOverhead / unattributed (card 58d5a36f) — opt-in via taskBreakdown, scoped
  //    to ONE project. A dedicated project (pT) + two tasks (task1/task2) so these additions can't
  //    perturb the "all"/pA/pB totals already asserted above. Every sample below carries ITS OWN
  //    denormalized taskId at insert time (matching what the sampler actually writes) EXCEPT t-hist,
  //    which deliberately omits it to simulate a row recorded before this column existed — that is the
  //    ONLY null-taskId sample in this fixture; t-mgr/t-plat/t-mgr2 carry an EXPLICIT taskId (null, null,
  //    and "task1" respectively) to make the role-vs-taskId precedence test (M2 below) meaningful.
  //    These three buckets are a STRICT PARTITION — byTask + orchestrationOverhead + unattributed must
  //    sum EXACTLY to totals (asserted at the end). Covered, by mutant the Code Review named:
  //      - a recycle chain (sess-t1 + sess-t1-recycle, same taskId) summed as ONE byTask row, PLUS a
  //        null-taskId HISTORICAL sample resolved via the live sessions.task_id join fallback (t-hist).
  //      - M2: a manager session whose OWN taskId is set (sess-tm2, taskId "task1") — its sample must
  //        land in orchestrationOverhead, NEVER byTask[task1], proving the role check takes priority over
  //        a non-null effective task id, not just a null one.
  //      - M9: a worker session with NO taskId, whose session row is then DELETED (purged) before the
  //        aggregate call (sess-orphan) — its sample has no denormalized taskId AND the join fallback now
  //        resolves nothing (session gone) → lands in `unattributed`, not silently dropped or misattributed.
  //      - M10: a worker session with a denormalized taskId on its OWN sample, whose session row is then
  //        ALSO deleted (sess-t2-purged) — the sample's OWN column still resolves it to task2 WITHOUT
  //        needing the live join, proving the denormalized column really does survive a purge (G1's whole
  //        point) — not just "survives as long as the live row sticks around to fall back on".
  // =====================================================================================================
  db.insertProject({ id: "pT", name: "Tasky", repoPath: tmpHome, vaultPath: tmpHome, config: {}, archivedAt: null, createdAt: now });
  mkAgent("aT1", "pT", "Tasker One");
  db.insertTask({
    id: "task1", projectId: "pT", title: "Task One", body: "", columnKey: "in_progress", position: 0,
    priority: "p2", held: false, heldBy: null, createdAt: now, updatedAt: now,
  });
  db.insertTask({
    id: "task2", projectId: "pT", title: "Task Two", body: "", columnKey: "in_progress", position: 1,
    priority: "p2", held: false, heldBy: null, createdAt: now, updatedAt: now,
  });
  const mkTaskSession = (id, role, taskId) => db.insertSession({
    id, projectId: "pT", agentId: "aT1", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId,
  });
  mkTaskSession("sess-t1", "worker", "task1");
  mkTaskSession("sess-t1-recycle", "worker", "task1"); // a SECOND session row, same task (a recycle chain)
  mkTaskSession("sess-tm", "manager", null);           // never gets a taskId — orchestration overhead
  mkTaskSession("sess-tp", "platform", null);          // same carve-out as manager
  mkTaskSession("sess-tm2", "manager", "task1");       // M2: a manager session whose OWN taskId IS set
  mkTaskSession("sess-orphan", "worker", null);        // M9: a worker with no task, later PURGED
  mkTaskSession("sess-t2-purged", "worker", "task2");  // M10: a worker WITH a task, later PURGED

  const tsNow = isoAgo(1); // just-now, well inside every window used below
  const seedTask = (id, sessionId, taskId, [i, o, cc, cr, cost]) => db.insertUsageSample({
    id, sessionId, projectId: "pT", agentId: "aT1", model: "claude-opus-4-8", ts: tsNow, taskId,
    inputTokens: i, outputTokens: o, cacheCreationTokens: cc, cacheReadTokens: cr, costUsd: cost,
  });
  seedTask("t-s1", "sess-t1", "task1", [100, 40, 10, 5, 0.10]);
  seedTask("t-s2", "sess-t1-recycle", "task1", [50, 20, 5, 2, 0.05]);
  // The HISTORICAL row: taskId omitted on the sample (null), even though sess-t1's LIVE row carries one —
  // the read-side join fallback must still attribute it to task1.
  seedTask("t-hist", "sess-t1", null, [30, 10, 3, 1, 0.03]);
  seedTask("t-mgr", "sess-tm", null, [200, 80, 20, 8, 0.20]);
  seedTask("t-plat", "sess-tp", null, [70, 30, 7, 3, 0.07]);
  seedTask("t-mgr2", "sess-tm2", "task1", [55, 22, 5, 2, 0.05]);      // M2 fixture
  seedTask("t-orphan", "sess-orphan", null, [40, 15, 4, 2, 0.04]);    // M9 fixture
  seedTask("t-purged2", "sess-t2-purged", "task2", [20, 8, 2, 1, 0.02]); // M10 fixture

  // Purge the two sessions AFTER their samples are written (the samples must survive the purge — no FK) —
  // M9/M10 both depend on the session row being GONE by the time aggregateSessionUsage reads it.
  db.deleteSession("sess-orphan");
  db.deleteSession("sess-t2-purged");

  const sinceT = isoAgo(2 * HOUR);
  const noBreakdown = db.aggregateSessionUsage({ sinceIso: sinceT, projectId: "pT" });
  check("9 taskBreakdown omitted by default: byTask/orchestrationOverhead/unattributed are all undefined",
    noBreakdown.byTask === undefined && noBreakdown.orchestrationOverhead === undefined && noBreakdown.unattributed === undefined);
  check("9 totals (pT scope) cover all 8 seeded samples (input 100+50+30+200+70+55+40+20=565)",
    noBreakdown.totals.samples === 8 && noBreakdown.totals.inputTokens === 565);

  const withTask = db.aggregateSessionUsage({ sinceIso: sinceT, projectId: "pT", taskBreakdown: true });
  check("9 byTask has exactly TWO rows (task1, task2)", withTask.byTask.length === 2);
  const byTaskMap = Object.fromEntries(withTask.byTask.map((r) => [r.taskId, r]));
  check("9 byTask[task1] carries the task's title/columnKey + the summed totals — recycle chain + historical row ONLY (samples 3, input 180, cost 0.18); M2's sess-tm2 sample is EXCLUDED",
    byTaskMap.task1.taskTitle === "Task One" && byTaskMap.task1.taskColumnKey === "in_progress" &&
    byTaskMap.task1.samples === 3 && byTaskMap.task1.inputTokens === 180 && approx(byTaskMap.task1.costUsd, 0.18));
  check("9 (M10) byTask[task2] resolves purely from the sample's OWN denormalized taskId, even though sess-t2-purged no longer exists (samples 1, input 20, cost 0.02)",
    byTaskMap.task2.taskTitle === "Task Two" && byTaskMap.task2.samples === 1 &&
    byTaskMap.task2.inputTokens === 20 && approx(byTaskMap.task2.costUsd, 0.02));
  check("9 (M2) orchestrationOverhead sums manager + platform + the manager-WITH-a-taskId sample (samples 3, input 200+70+55=325, cost 0.32)",
    withTask.orchestrationOverhead.samples === 3 && withTask.orchestrationOverhead.inputTokens === 325 &&
    approx(withTask.orchestrationOverhead.costUsd, 0.32));
  check("9 (M9) unattributed covers the purged, taskless worker session (samples 1, input 40, cost 0.04)",
    withTask.unattributed.samples === 1 && withTask.unattributed.inputTokens === 40 && approx(withTask.unattributed.costUsd, 0.04));
  check("9 byTask + orchestrationOverhead + unattributed sum EXACTLY to totals.samples ((3+1)+3+1=8) and .inputTokens ((180+20)+325+40=565)",
    (byTaskMap.task1.samples + byTaskMap.task2.samples + withTask.orchestrationOverhead.samples + withTask.unattributed.samples) === withTask.totals.samples &&
    (byTaskMap.task1.inputTokens + byTaskMap.task2.inputTokens + withTask.orchestrationOverhead.inputTokens + withTask.unattributed.inputTokens) === withTask.totals.inputTokens);

  // taskBreakdown is honored ONLY when scoped to one real project — a cross-project "all" request ignores
  // it (DB-layer contract; the route below additionally never even sets it true for "all"/missing/unknown).
  const crossProject = db.aggregateSessionUsage({ sinceIso: sinceT, taskBreakdown: true });
  check("9 taskBreakdown computes even in 'all' scope when asked directly at the DB layer (route gates this, not the DB method)",
    Array.isArray(crossProject.byTask));

  // -- ROUTE: taskBreakdown=true + a real projectId returns byTask/orchestrationOverhead/unattributed.
  const rTask = await get(`?since=${encodeURIComponent(sinceT)}&projectId=pT&taskBreakdown=true`);
  const bTask = rTask.json();
  check("9 route: taskBreakdown=true + projectId=pT returns byTask (2 rows) + orchestrationOverhead + unattributed",
    rTask.statusCode === 200 && Array.isArray(bTask.byTask) && bTask.byTask.length === 2 &&
    bTask.orchestrationOverhead?.samples === 3 && bTask.unattributed?.samples === 1);

  const rTaskNoFlag = await get(`?since=${encodeURIComponent(sinceT)}&projectId=pT`);
  check("9 route: no taskBreakdown param → byTask/orchestrationOverhead/unattributed all omitted",
    rTaskNoFlag.json().byTask === undefined && rTaskNoFlag.json().orchestrationOverhead === undefined && rTaskNoFlag.json().unattributed === undefined);

  const rTaskAllScope = await get(`?since=${encodeURIComponent(sinceT)}&taskBreakdown=true`);
  check("9 route: taskBreakdown=true with NO projectId (all scope) → omitted (per-project only)",
    rTaskAllScope.json().byTask === undefined && rTaskAllScope.json().orchestrationOverhead === undefined && rTaskAllScope.json().unattributed === undefined);

  // -- ROUTE (point 5): taskBreakdown=true + a projectId that does NOT resolve to a real project → omitted
  //    too, same as the "all" case, never an empty-but-present breakdown for a bad id.
  const rTaskUnknownProject = await get(`?since=${encodeURIComponent(sinceT)}&projectId=pDoesNotExist&taskBreakdown=true`);
  check("9 route: taskBreakdown=true + a NON-EXISTENT projectId → omitted, not an empty array/zeroed row",
    rTaskUnknownProject.statusCode === 200 && rTaskUnknownProject.json().byTask === undefined &&
    rTaskUnknownProject.json().orchestrationOverhead === undefined && rTaskUnknownProject.json().unattributed === undefined);

  await app.close();
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session usage telemetry data layer: insertUsageSample + aggregateSessionUsage (totals + byProject/byAgent name-joins + byDay buckets + bySession role-joins + cacheHitRatio + projectId filter + empty + since cutoff) + pruneUsageSamples, and GET /api/usage/sessions/history clamp/echo/bySession/cacheHitRatio — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
