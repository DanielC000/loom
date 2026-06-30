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
//   • projectId FILTER — scoping to one project narrows totals + every breakdown; "all"/omitted spans all.
//   • EMPTY case — a project with no samples → zeroed totals + empty breakdowns.
//   • SINCE cutoff — a row older than the cutoff is excluded; widening re-includes it.
//   • pruneUsageSamples — drops rows older than a cutoff (and is a no-op the second time).
//   • ROUTE — GET /api/usage/sessions/history clamps a bad/missing `since` to 30d, echoes since+filter.
// Run: 1) build (turbo builds shared first), 2) node test/usage-samples.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // "all" is treated identically to omitted (spans every project).
  const allKeyword = db.aggregateSessionUsage({ sinceIso: since30, projectId: "all" });
  check("4 projectId=\"all\" spans every project (same as omitted)", allKeyword.totals.samples === 5 && allKeyword.byProject.length === 2);

  // =====================================================================================================
  // 5) EMPTY case — a project with no samples → zeroed totals + empty breakdowns.
  // =====================================================================================================
  const empty = db.aggregateSessionUsage({ sinceIso: since30, projectId: "pEmpty" });
  check("5 empty project → totals all zero", empty.totals.samples === 0 && empty.totals.inputTokens === 0 && empty.totals.costUsd === 0);
  check("5 empty project → empty byProject + byAgent + byDay", empty.byProject.length === 0 && empty.byAgent.length === 0 && empty.byDay.length === 0);

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

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session usage telemetry data layer: insertUsageSample + aggregateSessionUsage (totals + byProject/byAgent name-joins + byDay buckets + projectId filter + empty + since cutoff) + pruneUsageSamples, and GET /api/usage/sessions/history clamp/echo — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
