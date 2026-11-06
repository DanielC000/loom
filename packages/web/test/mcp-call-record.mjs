// Hermetic unit test for the codex half of the session MCP activity strip — src/lib/mcpCallRecord.ts,
// card d4d3481e. A codex session's strip reads GET /api/sessions/:id/mcp-calls (rows shaped as the daemon's
// db.ts listMcpCalls serves them, newest first); every other harness keeps reading the transcript.
// Run it with: node --experimental-strip-types packages/web/test/mcp-call-record.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

// mcpCallRecord.ts imports ./mcpActivity bundler-style (no extension); the hook resolves it.
register("./_tsxLoaderHook.mjs", import.meta.url);
const {
  recordToMcpCalls, recordSentenceOf, mcpSourceFor, mcpRecordQuery, MCP_RECORD_LIMIT,
} = await import("../src/lib/mcpCallRecord.ts");
const { sentenceText, groupByTurn, turnSpanMs } = await import("../src/lib/mcpActivity.ts");

const T0 = Date.parse("2026-11-06T10:14:05.000Z");
// Newest first, as the route serves them. One refused (an {error} envelope), one transport error, one row
// whose duration is missing, and one outcome outside the record's vocabulary.
const ROWS = [
  { id: 14, router: "loom-tasks", tool: "decisions_for", startedAt: T0 + 9000, durationMs: 3, outcome: "ok", errClass: null, attribution: null, agentId: null, agentType: null },
  { id: 13, router: "loom-tasks", tool: "memory_read", startedAt: T0 + 6000, durationMs: null, outcome: "ok", errClass: null },
  { id: 12, router: "loom-orchestration", tool: "worker_spawn", startedAt: T0 + 4000, durationMs: 1450, outcome: "refused", errClass: "envelope" },
  { id: 11, router: "loom-orchestration", tool: "worker_redirect", startedAt: T0 + 2000, durationMs: 88, outcome: "error", errClass: "throw" },
  { id: 10, router: "loom-tasks", tool: "tasks_update", startedAt: T0, durationMs: 42, outcome: "ok", errClass: null },
  { id: 15, router: "loom-tasks", tool: "tasks_list", startedAt: T0 + 10000, durationMs: 7, outcome: "mystery", errClass: null },
];

// Mapping: oldest first by id, one turn, nothing invented.
{
  const calls = recordToMcpCalls(ROWS);
  assert.deepEqual(calls.map((c) => c.tool), ["tasks_update", "worker_redirect", "worker_spawn", "memory_read", "decisions_for", "tasks_list"]);
  assert.deepEqual(calls.map((c) => c.seq), [1, 2, 3, 4, 5, 6]);
  for (const c of calls) {
    assert.equal(c.turn, 0, "the record has no turns");
    assert.equal(c.tag, null);
    assert.deepEqual(c.args, {}, "the record never carries arguments");
    assert.equal(c.result, null, "the record never carries an answer");
    assert.notEqual(c.outcome, "pending", "a recorded call has always finished");
  }
  const [upd, redirect, spawn, mem, dec, list] = calls;
  assert.equal(upd.router, "loom-tasks");
  assert.equal(upd.subsystem, "board");
  assert.equal(upd.at, "2026-11-06T10:14:05.000Z");
  assert.equal(upd.ms, 42);
  // The outcome classes map one to one.
  assert.equal(upd.outcome, "ok");
  assert.equal(redirect.outcome, "error");
  assert.equal(redirect.subsystem, "fleet");
  assert.equal(spawn.outcome, "refused");
  assert.equal(spawn.ms, 1450);
  // A missing duration stays missing: never 0.
  assert.equal(mem.ms, null);
  assert.equal(mem.at, new Date(T0 + 6000).toISOString());
  assert.equal(dec.ms, 3);
  // Anything outside ok/refused/error reads ok, as the daemon's own classifier treats it.
  assert.equal(list.outcome, "ok");
  // The input is not mutated (it is react-query's cached array).
  assert.equal(ROWS[0].id, 14);
}

// Durations and times that are not real numbers are absent, not 0 or "1970".
{
  const [neg, nan, zero, str] = recordToMcpCalls([
    { id: 1, router: "loom-tasks", tool: "tasks_get", startedAt: T0, durationMs: -5, outcome: "ok", errClass: null },
    { id: 2, router: "loom-tasks", tool: "tasks_get", startedAt: Number.NaN, durationMs: Number.NaN, outcome: "ok", errClass: null },
    { id: 3, router: "loom-tasks", tool: "tasks_get", startedAt: 0, durationMs: 0, outcome: "ok", errClass: null },
    { id: 4, router: "loom-tasks", tool: "tasks_get", startedAt: "x", durationMs: "12", outcome: "ok", errClass: null },
  ]);
  assert.equal(neg.ms, null);
  assert.equal(nan.ms, null);
  assert.equal(nan.at, null);
  assert.equal(zero.ms, 0, "a measured 0ms is a real duration");
  assert.equal(zero.at, null, "startedAt 0 is no time");
  assert.equal(str.ms, null);
  assert.equal(str.at, null);
  assert.deepEqual(recordToMcpCalls([]), []);
}

// One group, and its span is wall clock from the first start to the last return.
{
  const calls = recordToMcpCalls(ROWS);
  const groups = groupByTurn(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].calls.length, 6);
  assert.equal(groups[0].calls[0].tool, "tasks_list", "newest first within the group");
  assert.equal(turnSpanMs(calls), 10007);
}

// Sentences: no object (none is recorded), and never a lead left hanging on a preposition.
{
  const calls = recordToMcpCalls(ROWS);
  const text = (c) => { const s = recordSentenceOf(c); return [s.lead, s.object, s.tail].filter(Boolean).join(" "); };
  const byTool = Object.fromEntries(calls.map((c) => [c.tool, c]));
  assert.equal(text(byTool.tasks_update), "Updated card");
  assert.equal(text(byTool.worker_redirect), "Tried to redirect worker");
  assert.equal(text(byTool.worker_spawn), "Tried to spawn a worker for card");
  assert.equal(text(byTool.memory_read), "Read memory note");
  assert.equal(text(byTool.tasks_list), "Listed the board");
  // "Looked up decisions for" has nowhere to go: the bare tool name instead.
  assert.equal(sentenceText(byTool.decisions_for), "Looked up decisions for");
  assert.equal(text(byTool.decisions_for), "Ran decisions_for");
  assert.equal(text({ ...byTool.decisions_for, outcome: "error" }), "Tried to run decisions_for");
  assert.equal(text({ ...byTool.decisions_for, tool: "memory_list" }), "Listed memory");
  // An unknown tool already reads "Called <tool>".
  assert.equal(text({ ...byTool.tasks_update, tool: "brand_new_tool" }), "Called brand_new_tool");
  for (const c of calls) assert.ok(text(c).trim(), `a sentence for ${c.tool}`);
}

// Source: only codex reads the record.
{
  assert.equal(mcpSourceFor("codex"), "record");
  for (const h of ["claude", null, undefined, ""]) assert.equal(mcpSourceFor(h), "transcript", String(h));
  assert.equal(MCP_RECORD_LIMIT, 500);
}

// A real QueryObserver: a claude session never fetches the record; a codex session does, on its own key.
{
  const settle = () => new Promise((r) => setTimeout(r, 30));
  for (const harness of ["claude", null, undefined]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fetched = 0;
    const obs = new QueryObserver(qc, mcpRecordQuery("s-claude", harness, async () => { fetched++; return { calls: [], dropped: 0, writeFailures: 0 }; }, false));
    const unsub = obs.subscribe(() => {});
    await settle();
    qc.invalidateQueries(); // an invalidation (e.g. a fleet signal) must not wake a disabled query either
    await settle();
    assert.equal(fetched, 0, `harness ${String(harness)} must never call api.mcpCalls`);
    unsub();
    qc.clear();
  }
  {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen = [];
    const opts = mcpRecordQuery("s-codex", "codex", async (id) => { seen.push(id); return { calls: ROWS, dropped: 0, writeFailures: 0 }; }, 5000);
    assert.deepEqual(opts.queryKey, ["mcp-calls", "s-codex"]);
    assert.equal(opts.refetchInterval, 5000, "the caller's mcpPollInterval passes straight through");
    const obs = new QueryObserver(qc, opts);
    const unsub = obs.subscribe(() => {});
    await settle();
    assert.deepEqual(seen, ["s-codex"]);
    assert.equal(qc.getQueryData(["mcp-calls", "s-codex"]).calls.length, 6);
    assert.equal(qc.getQueryData(["transcript", "s-codex"]), undefined, "the record never lands in the transcript key");
    unsub();
    qc.clear();
  }
}

// The component wires the record query through mcpRecordQuery only, keeps the claude transcript query on
// its shared key and cadence, and api.mcpCalls has no other caller in the web source.
{
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const comp = fs.readFileSync(path.join(SRC, "components", "McpActivity.tsx"), "utf8");
  assert.match(comp, /useQuery\(mcpRecordQuery\(sessionId, harness, api\.mcpCalls, interval\)\)/);
  assert.match(comp, /queryKey: \["transcript", sessionId\]/);
  assert.match(comp, /enabled: source === "transcript"/);
  assert.match(comp, /const interval = mcpPollInterval\(\{ hidden, expanded, busy \}\)/);
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /\bmcpCalls\b/.test(fs.readFileSync(p, "utf8"))) callers.push(path.relative(SRC, p).replace(/\\/g, "/"));
    }
  };
  walk(SRC);
  assert.deepEqual(callers.sort(), ["components/McpActivity.tsx", "lib/api.ts"]);
}

console.log("mcp-call-record: ok");
