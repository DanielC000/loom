// Hermetic unit test for the session MCP activity strip's parser — src/lib/mcpActivity.ts, card a9a7140c.
//
// The fixture below is written in the exact text shape the daemon's transcript route serves
// (packages/daemon/src/pty/claude-transcript.ts `extractText`): a call line is
// `[tool] {<tag>} <name>(<JSON.stringify(args)>)`, a result is `-> tool result {<tag>}[ (error)]: <body>`.
// If those markers change in the daemon, this file and the parser must change with them.
//
// Record: docs/decisions/a9a7140c-session-mcp-activity.md
// Run it with: node --experimental-strip-types packages/web/test/mcp-activity.mjs
import assert from "node:assert/strict";

const {
  parseMcpCalls, groupByTurn, sentenceOf, sentenceText, linksOf, applyFilter, emptyFilter, filterActive,
  tally, subsystemOf, isLoomRouter, SUBSYSTEMS, columnLabel, mcpPollInterval, MCP_POLL_ACTIVE_MS, MCP_POLL_IDLE_MS,
  classifyResult, isUnclassified, REFUSED_HINT,
  durationMs, turnSpanMs, fmtMs, fmtClock, fmtDateTime, durationBarPx, DURATION_BAR_MAX_PX,
} = await import("../src/lib/mcpActivity.ts");

// Poll policy. A poll can still be a whole transcript (first load, rotation fallback): the strip
// polls fast only when someone is watching it change, and never while the tab is hidden.
{
  const base = { hidden: false, expanded: false, busy: false };
  assert.equal(MCP_POLL_ACTIVE_MS, 5_000);
  assert.equal(MCP_POLL_IDLE_MS, 15_000);
  assert.equal(mcpPollInterval(base), MCP_POLL_IDLE_MS); // idle + compact: back off
  assert.equal(mcpPollInterval({ ...base, busy: true }), MCP_POLL_ACTIVE_MS);
  assert.equal(mcpPollInterval({ ...base, expanded: true }), MCP_POLL_ACTIVE_MS);
  // A hidden tab never polls, whatever else is true.
  for (const over of [{}, { busy: true }, { expanded: true }, { busy: true, expanded: true }]) {
    assert.equal(mcpPollInterval({ ...base, ...over, hidden: true }), false, `hidden + ${JSON.stringify(over)}`);
  }
}

const call = (tag, name, args) => `[tool] {${tag}} ${name}(${JSON.stringify(args)})`;
const T = [
  { role: "user", text: "Kick off: pick up card a9a7140c." },
  {
    role: "assistant",
    text: [
      "Let me look at the board first.",
      call("aaaa0001", "mcp__loom-tasks__tasks_list", { columnKey: "in_progress" }),
      call("aaaa0002", "Read", { file_path: "C:/x.ts" }),
    ].join("\n"),
  },
  // Two results in one tool_result turn, the first multi-line.
  { role: "tool_result", text: "-> tool result {aaaa0001}: [{\"id\":\"a9a7140c\"},\n{\"id\":\"525c8ad9\"}]\n-> tool result {aaaa0002}: 1 import x" },
  { role: "user", text: "[loom:from-worker] progress" },
  {
    role: "assistant",
    text: [
      call("bbbb0001", "mcp__loom-orchestration__worker_redirect", { sessionId: "1c07b3e5-0000-4000-8000-000000000000", text: "Stop: <b>rebase</b>" }),
      // Prose that LOOKS like a call marker but carries no JSON args is not a call.
      "[tool] {zzzz0000} mcp__loom-tasks__tasks_get(not json)",
    ].join("\n"),
  },
  { role: "tool_result", text: "-> tool result {bbbb0001} (error): MCP error -32602: session 1c07b3e5 is not live" },
  {
    role: "assistant",
    text: [
      call("bbbb0002", "mcp__loom-tasks__tasks_update", { id: "a9a7140c-3591-403c-9c2b-6f2311de7f37", columnKey: "review" }),
      call("bbbb0003", "mcp__loom-tasks__some_future_tool", { key: "k" }),
    ].join("\n"),
  },
  { role: "tool_result", text: "-> tool result {bbbb0002}: {\"ok\":true}" },
  // bbbb0003 never gets a result: still pending.
];

const calls = parseMcpCalls(T);

// Only Loom MCP routers count; the native Read call and the non-JSON look-alike are dropped.
assert.deepEqual(calls.map((c) => c.tool), ["tasks_list", "worker_redirect", "tasks_update", "some_future_tool"]);
assert.deepEqual(calls.map((c) => c.router), ["loom-tasks", "loom-orchestration", "loom-tasks", "loom-tasks"]);
assert.deepEqual(calls.map((c) => c.seq), [1, 2, 3, 4]);

// Turns count user-role turns; tool_result turns do not open a new turn.
assert.deepEqual(calls.map((c) => c.turn), [1, 2, 2, 2]);

// Pairing by tag, the error flag, a multi-line body, and an unanswered call.
assert.deepEqual(calls.map((c) => c.outcome), ["ok", "error", "ok", "pending"]);
assert.equal(calls[0].result, "[{\"id\":\"a9a7140c\"},\n{\"id\":\"525c8ad9\"}]");
assert.equal(calls[1].result, "MCP error -32602: session 1c07b3e5 is not live");
assert.equal(calls[3].result, null);
assert.equal(calls[1].args.text, "Stop: <b>rebase</b>"); // kept verbatim as data; the UI renders it as text

// Sentences: the owner's example, the error and pending framings, a full uuid shortened, the fallback.
assert.equal(sentenceText(calls[2]), "Moved card a9a7140c to Review");
assert.deepEqual(sentenceOf(calls[2]), { lead: "Moved card", object: "a9a7140c", tail: "to Review" });
assert.equal(sentenceText(calls[1]), "Tried to redirect worker 1c07b3e5");
assert.equal(sentenceText(calls[0]), "Listed the board · In progress");
assert.equal(sentenceText(calls[3]), "Asking Loom to call some_future_tool");
assert.equal(sentenceText({ ...calls[3], outcome: "ok" }), "Called some_future_tool");
assert.equal(columnLabel("in_progress"), "In progress");

// Grouping: newest turn first, newest call first within it.
const groups = groupByTurn(calls);
assert.deepEqual(groups.map((g) => g.turn), [2, 1]);
assert.deepEqual(groups[0].calls.map((c) => c.seq), [4, 3, 2]);

// Links read from the arguments.
assert.deepEqual(linksOf(calls[2]), [{ kind: "card", id: "a9a7140c" }]);
assert.deepEqual(linksOf(calls[1]), [{ kind: "worker", id: "1c07b3e5" }]);
assert.deepEqual(linksOf(calls[3]), [{ kind: "note", id: "k" }]);

// Subsystems.
assert.equal(subsystemOf("tasks_update"), "board");
assert.equal(subsystemOf("worker_merge_confirm"), "gate");
assert.equal(subsystemOf("worker_spawn"), "fleet");
assert.equal(subsystemOf("memory_read"), "memory");
assert.equal(subsystemOf("question_ask"), "inbox");
assert.equal(subsystemOf("my_context"), "self");
// Card 6232d9b4: the built-in platform, setup and audit tools no longer all land in self.
assert.equal(subsystemOf("project_create", "loom-platform"), "workspace");
assert.equal(subsystemOf("agent_update", "loom-setup"), "workspace");
assert.equal(subsystemOf("profile_assign", "loom-setup"), "workspace");
assert.equal(subsystemOf("list_all_projects", "loom-platform"), "workspace");
assert.equal(subsystemOf("git_commit", "loom-platform"), "workspace");
assert.equal(subsystemOf("skill_write", "loom-platform"), "workspace");
assert.equal(subsystemOf("project_task_create", "loom-platform"), "board"); // a card, not a project edit
assert.equal(subsystemOf("list_all_tasks", "loom-platform"), "board");
assert.equal(subsystemOf("list_all_sessions", "loom-platform"), "fleet");
assert.equal(subsystemOf("session_spawn", "loom-setup"), "fleet");
assert.equal(subsystemOf("project_memory_search", "loom-platform"), "memory");
assert.equal(subsystemOf("question_pull", "loom-platform"), "inbox");
assert.equal(subsystemOf("gate_history", "loom-orchestration"), "gate");
// Every audit-router tool is audit work, whichever prefix it carries, except ending the session; the codex
// record names the same router without the loom- prefix.
for (const r of ["loom-audit", "loom-user-audit", "audit", "user-audit"]) {
  for (const t of ["transcript_read", "repo_grep", "requests_list", "audit_file_finding", "skill_read"]) {
    assert.equal(subsystemOf(t, r), "audit", `${r} ${t}`);
  }
  assert.equal(subsystemOf("end_me", r), "self", r);
}
assert.equal(subsystemOf("end_me", "loom-setup"), "self");
assert.ok(SUBSYSTEMS.some((s) => s.key === "external"), "the facet rail can show third-party calls");

// Filtering narrows, and each facet kind actually applies.
const f = emptyFilter();
assert.equal(filterActive(f), false);
assert.equal(applyFilter(calls, f).length, 4);
assert.deepEqual(applyFilter(calls, { ...f, outcomes: new Set(["error"]) }).map((c) => c.seq), [2]);
assert.deepEqual(applyFilter(calls, { ...f, subsystems: new Set(["fleet"]) }).map((c) => c.seq), [2]);
assert.deepEqual(applyFilter(calls, { ...f, router: "loom-orchestration" }).map((c) => c.seq), [2]);
assert.deepEqual(applyFilter(calls, { ...f, tool: "tasks_update" }).map((c) => c.seq), [3]);
assert.deepEqual(applyFilter(calls, { ...f, query: "REVIEW" }).map((c) => c.seq), [3]);
assert.equal(filterActive({ ...f, query: "x" }), true);

// Tallies, most frequent first.
assert.deepEqual(tally(calls, "router"), [["loom-tasks", 3], ["loom-orchestration", 1]]);

// Refused (card 825e38da): a heuristic over a SUCCESSFUL result's body, kept distinct from isError.
{
  // The five shapes the card names, against the classifier directly.
  assert.equal(classifyResult('{"error":"concurrency cap reached: 3 of 3 live workers.","capacity":{"live":3,"max":3}}', false), "refused");
  assert.equal(classifyResult('{\n  "error": "conflict: baseVersion 3 is stale",\n  "conflict": true\n}', false), "refused"); // pretty-printed
  assert.equal(classifyResult('{"ok":true,"id":"a9a7140c"}', false), "ok");
  assert.equal(classifyResult('{"error":"cap reached"}', true), "error"); // isError wins: refused ≠ failed
  assert.equal(classifyResult("MCP error -32602: session is not live", true), "error");
  assert.equal(classifyResult('[{"error":"x"}]', false), "ok"); // an array body is not an object
  assert.equal(classifyResult('"error"', false), "ok"); // a JSON string
  assert.equal(classifyResult("error: plain text that mentions error", false), "ok");
  assert.equal(classifyResult('{"result":{"error":"nested"}}', false), "ok"); // top level only
  assert.equal(classifyResult('{"error":null}', false), "ok");
  assert.equal(classifyResult(null, false), "ok");
  const cut = `{"error":"cap reached","detail":"${"x".repeat(2100)}`.slice(0, 2048) + "... [+120 chars truncated]";
  assert.equal(classifyResult(cut, false), "ok"); // truncated + unparseable: never refused

  // End to end through the parser: the outcome lands on the call, beside a real ok and a real error.
  const R = parseMcpCalls([
    { role: "user", text: "go" },
    {
      role: "assistant",
      text: [
        call("cccc0001", "mcp__loom-orchestration__worker_spawn", { taskId: "7e2a90b4" }),
        call("cccc0002", "mcp__loom-tasks__tasks_get", { id: "7e2a90b4" }),
        call("cccc0003", "mcp__loom-tasks__memory_read", { key: "k" }),
        call("cccc0004", "mcp__loom-orchestration__worker_stop", { sessionId: "s1" }),
      ].join("\n"),
    },
    {
      role: "tool_result",
      text: [
        '-> tool result {cccc0001}: {"error":"concurrency cap reached","capacity":{"live":3,"max":3}}',
        '-> tool result {cccc0002}: {"id":"7e2a90b4","title":"x"}',
        `-> tool result {cccc0003}: ${cut}`,
        '-> tool result {cccc0004} (error): {"error":"not your worker"}',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(R.map((c) => c.outcome), ["refused", "ok", "ok", "error"]);
  assert.deepEqual(R.map(isUnclassified), [false, false, true, false]);
  assert.equal(sentenceText(R[0]), "Tried to spawn a worker for card 7e2a90b4");
  assert.deepEqual(applyFilter(R, { ...emptyFilter(), outcomes: new Set(["refused"]) }).map((c) => c.seq), [1]);
  assert.deepEqual(applyFilter(R, { ...emptyFilter(), outcomes: new Set(["error"]) }).map((c) => c.seq), [4]);
  assert.ok(REFUSED_HINT.includes("error field"));
}

// Time and approximate duration (card 0bcdd158): only from the turns' engine `ts`, never a fake 0.
{
  const a = "2026-11-06T10:00:00.000Z", b = "2026-11-06T10:00:00.042Z", c = "2026-11-06T10:00:01.500Z";
  assert.equal(durationMs(a, b), 42);
  assert.equal(durationMs(a, a), 0); // a real same-millisecond pair is a real 0
  assert.equal(durationMs(undefined, b), null, "missing call ts → none");
  assert.equal(durationMs(a, undefined), null, "missing result ts → none");
  assert.equal(durationMs(null, null), null);
  assert.equal(durationMs("not a date", b), null, "unparseable → none");
  assert.equal(durationMs(c, a), null, "result stamped before its call (out of order) → none, not a negative");

  const D = parseMcpCalls([
    { role: "user", text: "go", ts: a },
    { role: "assistant", ts: a, text: [
      call("dddd0001", "mcp__loom-tasks__tasks_get", { id: "x" }),
      call("dddd0002", "mcp__loom-tasks__tasks_list", {}),
    ].join("\n") },
    { role: "tool_result", ts: b, text: "-> tool result {dddd0001}: {}" },
    // An untimed result line: the call keeps its time, but gets no duration.
    { role: "tool_result", text: "-> tool result {dddd0002}: []" },
    { role: "assistant", text: call("dddd0003", "mcp__loom-tasks__tasks_get", { id: "y" }) }, // untimed call
    { role: "tool_result", ts: c, text: "-> tool result {dddd0003}: {}" },
    { role: "assistant", ts: c, text: call("dddd0004", "mcp__loom-memory__memory_read", { key: "k" }) },
    { role: "tool_result", ts: a, text: "-> tool result {dddd0004}: {}" }, // out of order
    { role: "assistant", ts: c, text: call("dddd0005", "mcp__loom-tasks__tasks_get", { id: "z" }) }, // pending
  ]);
  assert.deepEqual(D.map((x) => x.at), [a, a, null, c, c]);
  assert.deepEqual(D.map((x) => x.ms), [42, null, null, null, null]);
  // The turn span counts only calls with BOTH ts: call 1 alone here (call 2 has no result ts, call 3 no
  // call ts, call 4 is out of order, call 5 pending).
  assert.equal(turnSpanMs(D), 42);
  // Two calls issued together and answered at different times: the span is wall clock (first call to
  // last answer, 1500ms), NOT the sum of their durations (42 + 1500 = 1542), which double-counts overlap.
  const P = parseMcpCalls([
    { role: "user", text: "go", ts: a },
    { role: "assistant", ts: a, text: [call("eeee0001", "mcp__loom-tasks__tasks_get", { id: "x" }), call("eeee0002", "mcp__loom-tasks__tasks_list", {})].join("\n") },
    { role: "tool_result", ts: b, text: "-> tool result {eeee0001}: {}" },
    { role: "tool_result", ts: c, text: "-> tool result {eeee0002}: []" },
  ]);
  assert.deepEqual(P.map((x) => x.ms), [42, 1500]);
  assert.equal(turnSpanMs(P), 1500, "span is first call to last answer, not a sum");
  // A transcript with no ts at all (an older cache, or a route that does not send it): nothing is timed.
  assert.ok(calls.every((x) => x.at === null && x.ms === null));
  assert.equal(turnSpanMs(calls), null);
  // A turn whose only timed call is still pending has a clock time but no span.
  assert.equal(turnSpanMs(D.slice(4)), null);
  assert.match(fmtDateTime(a), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

  assert.equal(fmtMs(42), "42ms");
  assert.equal(fmtMs(1450), "1.4s");
  assert.equal(fmtMs(18_900), "18s");
  assert.equal(fmtMs(185_000), "3m 05s");
  assert.match(fmtClock(a), /^\d\d:\d\d:\d\d$/);
  assert.equal(durationBarPx(0), 3);
  assert.equal(durationBarPx(10 * 60_000), DURATION_BAR_MAX_PX);
  assert.ok(durationBarPx(42) < durationBarPx(1450), "longer call, longer bar");
}

// Third-party MCP servers (card 6232d9b4): any mcp__<server>__<tool> is a call; a native tool is not.
{
  const X = parseMcpCalls([
    { role: "user", text: "check the page" },
    {
      role: "assistant",
      text: [
        call("ffff0001", "mcp__playwright__browser_navigate", { url: "http://127.0.0.1:5999/" }),
        call("ffff0002", "Bash", { command: "ls mcp__x__y" }), // native: no mcp__ prefix at the name
        call("ffff0003", "mcp__claude-in-chrome__read_page", { tabId: 3 }),
        call("ffff0004", "mcp__loom-platform__project_create", { name: "x" }),
        call("ffff0005", "mcp__plugin_kit_fs__read_file", { path: "a" }),
        call("ffff0006", "mcp__markitdown__convert_to_markdown", { uri: "file:///a.pdf" }),
        "[tool] {ffff0007} mcp_playwright_browser_click({})", // single underscores: not an MCP name
      ].join("\n"),
    },
    {
      role: "tool_result",
      text: [
        "-> tool result {ffff0001}: ### Page state\n- Page URL: http://127.0.0.1:5999/\n- Page Title: Loom",
        "-> tool result {ffff0002}: a.txt",
        `-> tool result {ffff0003} (error): {"error":"no tab"}`,
        '-> tool result {ffff0004}: {"id":"p1"}',
      ].join("\n"),
    },
  ]);
  assert.deepEqual(X.map((c) => c.tool), ["browser_navigate", "read_page", "project_create", "read_file", "convert_to_markdown"]);
  assert.deepEqual(X.map((c) => c.router), ["playwright", "claude-in-chrome", "loom-platform", "plugin_kit_fs", "markitdown"]);
  assert.deepEqual(X.map((c) => c.subsystem), ["external", "external", "workspace", "external", "external"]);
  assert.deepEqual(X.map((c) => c.outcome), ["ok", "error", "ok", "pending", "pending"]);
  // The result body is paired and kept as served (multi-line).
  assert.equal(X[0].result, "### Page state\n- Page URL: http://127.0.0.1:5999/\n- Page Title: Loom");
  assert.equal(X[0].args.url, "http://127.0.0.1:5999/");
  assert.equal(isLoomRouter("playwright"), false);
  assert.equal(isLoomRouter("loom-tasks"), true);
  // The sentence names the server, and an unanswered third-party call is not "asking Loom".
  assert.equal(sentenceText(X[0]), "Called browser_navigate on playwright");
  assert.equal(sentenceText(X[1]), "Tried to call read_page on claude-in-chrome");
  assert.equal(sentenceText(X[4]), "Asking markitdown to call convert_to_markdown");
  // A third-party tool that shares a Loom tool's name is still not phrased as the Loom tool.
  const lookalike = parseMcpCalls([{ role: "assistant", text: call("ffff0010", "mcp__github__tasks_update", { id: "a9a7140c", columnKey: "review" }) }]);
  assert.equal(lookalike[0].subsystem, "external");
  assert.equal(sentenceText({ ...lookalike[0], outcome: "ok" }), "Called tasks_update on github");
  // The server tally and filter see third-party servers beside Loom's routers.
  assert.deepEqual(tally(X, "router").map(([r]) => r), ["claude-in-chrome", "loom-platform", "markitdown", "playwright", "plugin_kit_fs"]);
  assert.deepEqual(applyFilter(X, { ...emptyFilter(), router: "playwright" }).map((c) => c.seq), [1]);
  assert.deepEqual(applyFilter(X, { ...emptyFilter(), subsystems: new Set(["external"]) }).map((c) => c.seq), [1, 2, 4, 5]);
  // A large answer arrives already cut at 2 KB by the daemon; the parser keeps exactly that, no more.
  const big = "x".repeat(2048) + "... [+50000 chars truncated]";
  const B = parseMcpCalls([
    { role: "assistant", text: call("ffff0020", "mcp__playwright__browser_snapshot", {}) },
    { role: "tool_result", text: `-> tool result {ffff0020}: ${big}` },
  ]);
  assert.equal(B[0].result, big);
  assert.equal(isUnclassified(B[0]), true);
}

// A transcript with no Loom calls (e.g. a codex session's different markers) parses to nothing.
assert.deepEqual(parseMcpCalls([{ role: "assistant", text: "ran `tasks_update` via the codex tool shape" }]), []);

console.log("mcp-activity: ok");
