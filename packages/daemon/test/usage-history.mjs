import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Usage history — read-only HISTORICAL token/cost aggregation over the `runs` table (Loom's only
// persisted time-series usage data; interactive sessions keep no history). HERMETIC + CLAUDE-FREE +
// NETWORK-FREE: a temp DB seeded with runs across two projects/agents at known timestamps, the REAL
// db.aggregateRunUsage exercised directly, plus the REAL buildServer driven by app.inject for the
// GET /api/usage/history clamp + echo.
//
// Covers the card's DoD:
//   • TOTALS — grand sums over the window (count + tokens + costUsd), excluding in-flight runs (no usage_json).
//   • byProject / byAgent — GROUP BY breakdowns joined to project/agent names.
//   • projectId FILTER — scoping to one project narrows totals + breakdowns; "all"/omitted spans all.
//   • EMPTY case — a project with no qualifying runs → zeroed totals + empty breakdowns.
//   • SINCE cutoff — a row older than the cutoff is excluded; widening the window re-includes it.
//   • ROUTE — GET /api/usage/history clamps a bad/missing `since` to 30d, echoes the applied since+filter.
// Run: 1) build (turbo builds shared first), 2) node test/usage-history.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-uhist-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45402";
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

try {
  const db = new Db(path.join(tmpHome, "uhist.db"));
  // Two projects, three agents (two in pA, one in pB).
  db.insertProject({ id: "pA", name: "Alpha", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Beta", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pEmpty", name: "Empty", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  const mkAgent = (id, projectId, name) => db.insertAgent({ id, projectId, name, startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });
  mkAgent("aA1", "pA", "Analyst One");
  mkAgent("aA2", "pA", "Analyst Two");
  mkAgent("aB1", "pB", "Beta Bot");

  // Seed COMPLETED runs carrying a cumulative usage snapshot (what teardown records). `usage` persists
  // as usage_json; the aggregator json_extracts $.inputTokens/$.costUsd/etc.
  const seed = (id, projectId, agentId, usage, createdAt) => db.insertRun({
    id, projectId, agentId, sessionId: null, keyId: null, status: "completed",
    input: null, schema: null, result: { ok: true }, usage,
    transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null,
    createdAt, startedAt: createdAt, endedAt: createdAt,
  });
  const u = (i, o, cc, cr, cost) => ({ inputTokens: i, outputTokens: o, cacheCreationTokens: cc, cacheReadTokens: cr, turns: 3, model: "claude-opus-4-8", costUsd: cost });

  // In-window runs (last few hours).
  seed("r1", "pA", "aA1", u(100, 40, 10, 5, 0.10), isoAgo(1 * HOUR));
  seed("r2", "pA", "aA2", u(200, 70, 20, 8, 0.20), isoAgo(2 * HOUR));
  seed("r3", "pB", "aB1", u(300, 90, 30, 12, 0.30), isoAgo(3 * HOUR));
  // OLD run (40 days ago) — excluded by the 30-day window, re-included by a wide one.
  seed("r4", "pA", "aA1", u(9999, 8888, 7777, 6666, 99), isoAgo(40 * DAY));
  // IN-FLIGHT run (no usage snapshot) — must be excluded from every count/sum.
  db.insertRun({
    id: "r5", projectId: "pB", agentId: "aB1", sessionId: "sess-x", keyId: null, status: "running",
    input: null, schema: null, result: null, usage: null,
    transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null,
    createdAt: isoAgo(1 * HOUR), startedAt: isoAgo(1 * HOUR), endedAt: null,
  });

  // =====================================================================================================
  // 1) TOTALS over the 30-day window — all projects. r4 (old) + r5 (no usage) excluded.
  // =====================================================================================================
  const since30 = isoAgo(30 * DAY);
  const all = db.aggregateRunUsage({ sinceIso: since30 });
  check("1 totals.runs counts only the 3 in-window runs WITH usage_json", all.totals.runs === 3);
  check("1 totals.inputTokens summed (100+200+300=600)", all.totals.inputTokens === 600);
  check("1 totals.outputTokens summed (40+70+90=200)", all.totals.outputTokens === 200);
  check("1 totals.cacheCreationTokens summed (10+20+30=60)", all.totals.cacheCreationTokens === 60);
  check("1 totals.cacheReadTokens summed (5+8+12=25)", all.totals.cacheReadTokens === 25);
  check("1 totals.costUsd summed (0.10+0.20+0.30=0.60)", approx(all.totals.costUsd, 0.60));

  // =====================================================================================================
  // 2) byProject / byAgent breakdowns (joined to names).
  // =====================================================================================================
  const proj = Object.fromEntries(all.byProject.map((r) => [r.projectId, r]));
  check("2 byProject covers exactly the two active projects", all.byProject.length === 2 && !!proj.pA && !!proj.pB);
  check("2 byProject[pA] name + runs(2) + input(300) + output(110) + cost(0.30)",
    proj.pA.projectName === "Alpha" && proj.pA.runs === 2 && proj.pA.inputTokens === 300 &&
    proj.pA.outputTokens === 110 && proj.pA.cacheCreationTokens === 30 && proj.pA.cacheReadTokens === 13 && approx(proj.pA.costUsd, 0.30));
  check("2 byProject[pB] name + runs(1) + input(300) + cost(0.30)",
    proj.pB.projectName === "Beta" && proj.pB.runs === 1 && proj.pB.inputTokens === 300 && approx(proj.pB.costUsd, 0.30));

  const ag = Object.fromEntries(all.byAgent.map((r) => [r.agentId, r]));
  check("2 byAgent covers exactly the three agents that ran", all.byAgent.length === 3 && !!ag.aA1 && !!ag.aA2 && !!ag.aB1);
  check("2 byAgent[aA1] name + runs(1, r4 excluded by cutoff) + input(100)",
    ag.aA1.agentName === "Analyst One" && ag.aA1.runs === 1 && ag.aA1.inputTokens === 100 && approx(ag.aA1.costUsd, 0.10));
  check("2 byAgent[aA2] name + runs(1) + input(200)", ag.aA2.agentName === "Analyst Two" && ag.aA2.runs === 1 && ag.aA2.inputTokens === 200);
  check("2 byAgent[aB1] name + runs(1, r5 in-flight excluded) + input(300)",
    ag.aB1.agentName === "Beta Bot" && ag.aB1.runs === 1 && ag.aB1.inputTokens === 300);
  // byAgent now carries the agent's OWNING project (projectId/projectName) to disambiguate identically-
  // named agents across projects in the "all" scope.
  check("2 byAgent[aA1] owning project (pA / Alpha)", ag.aA1.projectId === "pA" && ag.aA1.projectName === "Alpha");
  check("2 byAgent[aA2] owning project (pA / Alpha)", ag.aA2.projectId === "pA" && ag.aA2.projectName === "Alpha");
  check("2 byAgent[aB1] owning project (pB / Beta)", ag.aB1.projectId === "pB" && ag.aB1.projectName === "Beta");

  // =====================================================================================================
  // 3) projectId FILTER — scoping to pA narrows totals + breakdowns.
  // =====================================================================================================
  const onlyA = db.aggregateRunUsage({ sinceIso: since30, projectId: "pA" });
  check("3 filter=pA totals = pA only (runs 2, input 300, cost 0.30)",
    onlyA.totals.runs === 2 && onlyA.totals.inputTokens === 300 && approx(onlyA.totals.costUsd, 0.30));
  check("3 filter=pA byProject is just pA", onlyA.byProject.length === 1 && onlyA.byProject[0].projectId === "pA");
  check("3 filter=pA byAgent excludes pB's agent (only aA1,aA2)",
    onlyA.byAgent.length === 2 && onlyA.byAgent.every((r) => r.agentId === "aA1" || r.agentId === "aA2"));
  // "all" is treated identically to omitted (spans every project).
  const allKeyword = db.aggregateRunUsage({ sinceIso: since30, projectId: "all" });
  check("3 projectId=\"all\" spans every project (same as omitted)", allKeyword.totals.runs === 3 && allKeyword.byProject.length === 2);

  // =====================================================================================================
  // 4) EMPTY case — a project with no qualifying runs → zeroed totals + empty breakdowns.
  // =====================================================================================================
  const empty = db.aggregateRunUsage({ sinceIso: since30, projectId: "pEmpty" });
  check("4 empty project → totals all zero", empty.totals.runs === 0 && empty.totals.inputTokens === 0 && empty.totals.costUsd === 0);
  check("4 empty project → empty byProject + byAgent", empty.byProject.length === 0 && empty.byAgent.length === 0);

  // =====================================================================================================
  // 5) SINCE cutoff — older rows excluded; widening the window re-includes r4 (40 days old).
  // =====================================================================================================
  const wide = db.aggregateRunUsage({ sinceIso: isoAgo(400 * DAY) });
  check("5 widening to 400d re-includes r4 (runs 4, input 600+9999=10599)",
    wide.totals.runs === 4 && wide.totals.inputTokens === 10599);
  const wideA1 = Object.fromEntries(wide.byAgent.map((r) => [r.agentId, r]));
  check("5 widened byAgent[aA1] now counts both its runs (2, input 100+9999=10099)",
    wideA1.aA1.runs === 2 && wideA1.aA1.inputTokens === 10099);
  // A very recent cutoff excludes everything.
  const tight = db.aggregateRunUsage({ sinceIso: isoAgo(1) });
  check("5 a now-ish cutoff excludes all runs (runs 0)", tight.totals.runs === 0 && tight.byProject.length === 0);

  // =====================================================================================================
  // 6) ROUTE — GET /api/usage/history: clamp a missing/bad `since` to 30d, echo applied since+filter.
  // =====================================================================================================
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const get = (q) => app.inject({ method: "GET", url: `/api/usage/history${q}` });

  const r30 = await get(`?since=${encodeURIComponent(since30)}`);
  const b30 = r30.json();
  check("6 route 200 + echoes since + projectId:null (all) + the 3-run totals",
    r30.statusCode === 200 && b30.since === since30 && b30.projectId === null &&
    b30.totals.runs === 3 && b30.totals.inputTokens === 600);
  check("6 route returns byProject + byAgent breakdowns", b30.byProject.length === 2 && b30.byAgent.length === 3);

  const rFilter = await get(`?since=${encodeURIComponent(since30)}&projectId=pA`);
  const bFilter = rFilter.json();
  check("6 route projectId=pA echoed + scoped totals (runs 2)", bFilter.projectId === "pA" && bFilter.totals.runs === 2);

  // Missing `since` → clamped to ~30d ago (echoed since within ±1min of 30d).
  const rMissing = await get("");
  const bMissing = rMissing.json();
  const echoedAgoMs = Date.now() - Date.parse(bMissing.since);
  check("6 missing since → clamped to ~30d window (echoed since ≈ 30d ago)",
    rMissing.statusCode === 200 && Math.abs(echoedAgoMs - 30 * DAY) < 60_000);

  // Unparseable `since` → same default clamp (not NaN/crash).
  const rBad = await get("?since=not-a-date");
  check("6 unparseable since → 200 + clamped (not a crash)", rBad.statusCode === 200 && Number.isFinite(Date.parse(rBad.json().since)));

  // Older-than-1yr `since` → floored at 1yr ago (never an unbounded scan).
  const rAncient = await get(`?since=${encodeURIComponent(isoAgo(3 * 365 * DAY))}`);
  const ancientAgoMs = Date.now() - Date.parse(rAncient.json().since);
  check("6 since older than 1yr → floored at ~1yr ago", Math.abs(ancientAgoMs - 365 * DAY) < 60_000);

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — usage history: aggregateRunUsage totals + byProject/byAgent (name-joined) + projectId filter + empty case + since cutoff, and GET /api/usage/history clamp/echo — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
