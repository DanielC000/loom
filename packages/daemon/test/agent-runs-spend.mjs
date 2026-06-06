import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs #2 — per-run COST metering + daily SPEND cap enforcement. HERMETIC + CLAUDE-FREE +
// NETWORK-FREE, in the style of agent-runs-caps.mjs: the REAL buildServer driven by app.inject with
// sessions.startRun STUBBED (no pty/claude boots; the stub inserts the `running` run row a real start
// would), plus direct unit coverage of the cumulative-usage reader + the price model off dist/.
//
// Covers the card's DoD:
//   • PRICE MODEL — computeRunCostUsd prices input+output+cache per the per-model table; a date-suffixed
//     id resolves by prefix; an UNKNOWN model → cost 0 and NEVER throws.
//   • CUMULATIVE USAGE CAPTURE — readRunUsage sums output tokens across ALL turns and DEDUPES the
//     split assistant lines that share one message.id (the Step-1 finding — naïve summing double-counts).
//   • sumKeySpendSince — sums `usage.costUsd` over the trailing 24h; stale spend (>24h) is excluded.
//   • DAILY SPEND cap — at/over the cap → 429 { daily spend cap reached } + NO run started + a
//     cap_rejected{cap:"daily_spend"} audit row; under the cap → 202; an uncapped key is unaffected.
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-spend.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hermetic LOOM_HOME (+ sandboxed HOME) set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-aspend-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45394";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { computeRunCostUsd, priceForModel } = await import("../dist/sessions/pricing.js");
const { readRunUsage, readRunUsageFromFile } = await import("../dist/sessions/context.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");

const now = new Date().toISOString();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

try {
  // =====================================================================================================
  // 1) PRICE MODEL — computeRunCostUsd over the per-model table; unknown model → 0, never throws
  // =====================================================================================================
  // Opus 4.8 = $5/1M input, $25/1M output. cache write = 1.25× input, cache read = 0.1× input.
  const opusCost = computeRunCostUsd({
    inputTokens: 1_000_000, outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000, model: "claude-opus-4-8",
  });
  // 5 (input) + 25 (output) + 6.25 (cache write = 5×1.25) + 0.5 (cache read = 5×0.1) = 36.75
  check("1 opus-4-8 cost = input+output+cacheWrite+cacheRead (36.75)", approx(opusCost, 36.75));
  // Sonnet 4.6 = $3/$15: 30k in × 3/1e6 = 0.09, 60k out × 15/1e6 = 0.90 ⇒ 0.99
  const sonnetCost = computeRunCostUsd({ inputTokens: 30_000, outputTokens: 60_000, model: "claude-sonnet-4-6" });
  check("1 sonnet-4-6 cost = input+output (0.99)", approx(sonnetCost, 0.99));
  // a date-suffixed engine id resolves by longest-prefix match (haiku-4-5 = $1/$5).
  check("1 date-suffixed id resolves by prefix (haiku-4-5-20251001 priced)",
    priceForModel("claude-haiku-4-5-20251001")?.inputPerMillion === 1);
  const haikuCost = computeRunCostUsd({ inputTokens: 1_000_000, outputTokens: 0, model: "claude-haiku-4-5-20251001" });
  check("1 haiku date-suffixed cost computed via prefix ($1)", approx(haikuCost, 1));
  // UNKNOWN model → 0 and NO throw.
  let threw = false; let unknownCost = NaN;
  try { unknownCost = computeRunCostUsd({ inputTokens: 9_999_999, outputTokens: 9_999_999, model: "gpt-some-thing" }); }
  catch { threw = true; }
  check("1 unknown model → cost 0, NO throw", !threw && unknownCost === 0);
  // null model → 0 and NO throw.
  let threwNull = false; let nullCost = NaN;
  try { nullCost = computeRunCostUsd({ inputTokens: 100, outputTokens: 100, model: null }); } catch { threwNull = true; }
  check("1 null model → cost 0, NO throw", !threwNull && nullCost === 0);

  // =====================================================================================================
  // 2) CUMULATIVE USAGE CAPTURE — sum over ALL turns + DEDUPE split lines sharing one message.id
  // =====================================================================================================
  // Unique temp cwd → collision-free transcript dir under the real (sandboxed) ~/.claude/projects.
  const cwd = path.join(os.tmpdir(), `loom-spend-tx-${Date.now()}-${process.pid}`);
  const txDir = path.dirname(engineTranscriptPath(cwd, "seed"));
  fs.mkdirSync(txDir, { recursive: true });
  const writeFixture = (id, lines) =>
    fs.writeFileSync(engineTranscriptPath(cwd, id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  // Turn A: ONE assistant message written as TWO JSONL lines (thinking + tool_use) sharing msg_A and the
  // SAME usage — must count ONCE. Turn B: a second distinct message. Cumulative = A + B (not A+A+B).
  const usageA = { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 };
  const usageB = { input_tokens: 200, output_tokens: 70, cache_creation_input_tokens: 20, cache_read_input_tokens: 8 };
  writeFixture("run1", [
    { type: "user", message: { content: "go" } },
    { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", content: [{ type: "thinking", thinking: "…" }], usage: usageA } },
    { type: "assistant", message: { id: "msg_A", model: "claude-opus-4-8", content: [{ type: "tool_use", name: "x", input: {} }], usage: usageA } },
    { type: "assistant", message: { id: "msg_B", model: "claude-opus-4-8", content: [{ type: "text", text: "done" }], usage: usageB } },
  ]);
  const cum = readRunUsage(cwd, "run1");
  check("2 cumulative inputTokens summed across turns, deduped by message.id (100+200=300)", cum?.inputTokens === 300);
  check("2 cumulative OUTPUT tokens summed (40+70=110) — the previously-uncaptured field", cum?.outputTokens === 110);
  check("2 cumulative cache-creation summed (10+20=30)", cum?.cacheCreationTokens === 30);
  check("2 cumulative cache-read summed (5+8=13)", cum?.cacheReadTokens === 13);
  check("2 distinct turns = 2 (split lines NOT double-counted)", cum?.turns === 2);
  check("2 model carried from the transcript", cum?.model === "claude-opus-4-8");
  // cost over the cumulative usage: in 300×5/1e6=0.0015, out 110×25/1e6=0.00275, cw 30×6.25/1e6=0.0001875,
  // cr 13×0.5/1e6=0.0000065 ⇒ 0.004444
  check("2 computeRunCostUsd over the cumulative usage (0.004444)", approx(computeRunCostUsd(cum), 0.004444));
  // missing transcript → null (degrade path).
  check("2 missing transcript → null", readRunUsageFromFile(path.join(txDir, "nope.jsonl")) === null);
  fs.rmSync(txDir, { recursive: true, force: true });

  // =====================================================================================================
  // 3) sumKeySpendSince + 4) DAILY SPEND cap enforcement (app.inject)
  // =====================================================================================================
  const db = new Db(path.join(tmpHome, "spend.db"));
  db.insertProject({ id: "pMain", name: "Main", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Analyst", startupPrompt: "doctrine", position: 0, profileId: null, endpoint: true, ioSchema: null });

  const mk = (caps) => db.createApiKey({ projectId: "pMain", name: "k", endpointAgentIds: ["aEndpoint"], caps });
  const SPEND = mk({ maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: 1.0 });   // daily spend cap = $1
  const UNDER = mk({ maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: 1.0 });
  const UNCAPPED = mk({ maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null });

  // Seed COMPLETED runs carrying a cumulative usage snapshot WITH costUsd (what teardown records).
  const seedSpend = (id, keyId, costUsd, createdAt) => db.insertRun({
    id, projectId: "pMain", agentId: "aEndpoint", sessionId: null, keyId, status: "completed",
    input: null, schema: null, result: { ok: true },
    usage: { inputTokens: 1000, outputTokens: 500, turns: 3, model: "claude-opus-4-8", costUsd },
    transcriptRef: null, error: null, webhookUrl: null, idempotencyKey: null, createdAt, startedAt: createdAt, endedAt: createdAt,
  });
  // SPEND key: two in-window runs totalling $1.20 (> the $1 cap).
  seedSpend("sp-a", SPEND.key.id, 0.7, isoAgo(1 * 60 * 60 * 1000));
  seedSpend("sp-b", SPEND.key.id, 0.5, isoAgo(2 * 60 * 60 * 1000));
  check("3 sumKeySpendSince sums in-window costUsd (1.2)", approx(db.sumKeySpendSince(SPEND.key.id, isoAgo(DAY)), 1.2));
  // stale spend (>24h) excluded.
  seedSpend("sp-old", SPEND.key.id, 99, isoAgo(2 * DAY));
  check("3 stale spend (2 days old) excluded from the 24h window (still 1.2)", approx(db.sumKeySpendSince(SPEND.key.id, isoAgo(DAY)), 1.2));

  // Stub sessions.startRun: insert the `running` row a real start would (so a 202 is observable + counted).
  const startCalls = [];
  let runSeq = 0;
  const fakeSessions = {
    startRun: async (opts) => {
      startCalls.push(opts);
      const id = `live-${++runSeq}`;
      db.insertRun({
        id, projectId: "pMain", agentId: opts.agentId, sessionId: `sess-${runSeq}`, keyId: opts.keyId ?? null,
        status: "running", input: opts.input, schema: opts.schema ?? null, result: null, usage: null,
        transcriptRef: null, error: null, webhookUrl: opts.webhook ?? null, idempotencyKey: opts.idempotencyKey ?? null,
        createdAt: new Date().toISOString(), startedAt: now, endedAt: null,
      });
      return { run: db.getRun(id), session: { id: `sess-${runSeq}` } };
    },
    cancelRun: (runId) => ({ status: db.getRun(runId)?.status ?? "cancelled" }),
  };
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: fakeSessions, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  const postRun = (token, payload) => app.inject({ method: "POST", url: "/api/runs", headers: token ? bearer(token) : {}, payload });
  const body = { agent: "aEndpoint", input: {} };

  const startsBefore = startCalls.length;
  const over = await postRun(SPEND.plaintext, body);
  check("4 at/over the daily spend cap → 429 { daily spend cap reached }",
    over.statusCode === 429 && over.json().error === "daily spend cap reached");
  check("4 the rejected run started NOTHING (startRun NOT called)", startCalls.length === startsBefore);
  // audit row recorded: cap_rejected{cap:"daily_spend"} with the observed sum + limit + agentId.
  const events = db.listRunEvents("pMain");
  const audit = events.find((e) => e.kind === "cap_rejected" && e.detail?.cap === "daily_spend");
  check("4 a cap_rejected{cap:\"daily_spend\"} audit row was written",
    !!audit && audit.keyId === SPEND.key.id && audit.runId === null &&
    audit.detail.limit === 1.0 && approx(audit.detail.observed, 1.2) && audit.detail.agentId === "aEndpoint");

  // UNDER the cap → 202 (spend $0.40 < $1 cap).
  seedSpend("un-a", UNDER.key.id, 0.4, isoAgo(1 * 60 * 60 * 1000));
  const under = await postRun(UNDER.plaintext, body);
  check("4 under the daily spend cap → 202 (run starts)", under.statusCode === 202);

  // an UNCAPPED key is unaffected even with large prior spend.
  seedSpend("uc-a", UNCAPPED.key.id, 500, isoAgo(1 * 60 * 60 * 1000));
  const uncapped = await postRun(UNCAPPED.plaintext, body);
  check("4 an UNCAPPED (dailySpendCap=null) key admits regardless of prior spend → 202", uncapped.statusCode === 202);

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { await sleep(50); } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs #2: per-model price table (input+output+cache; prefix-resolved; unknown→0, no throw) + cumulative per-run usage capture (output summed across turns, split lines deduped by message.id) + sumKeySpendSince (24h costUsd sum, stale excluded) + dailySpendCap enforcement (429 + daily_spend audit row at cap; 202 under; uncapped unaffected) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
