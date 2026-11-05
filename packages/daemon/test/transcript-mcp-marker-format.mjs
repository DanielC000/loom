import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card afea18a1 — pins the call/result marker format `pty/claude-transcript.ts` `extractText` emits, which
// the web session MCP activity strip (packages/web/src/lib/mcpActivity.ts, record a9a7140c) parses back
// with two regexes. Before this, only a hand-written web fixture (test/mcp-activity.mjs) pinned the shape,
// so a daemon-side marker change would have broken the strip silently.
//
// A REAL-shaped Claude JSONL transcript is written to a temp dir and rendered through the real dist
// `parseTranscriptFile`; the EXACT marker lines are asserted, and the web parser's regexes are applied to
// them. The two regexes below are COPIES of CALL_LINE / RESULT_HEAD in mcpActivity.ts (a TS module in
// another package cannot be imported from here) — if you change either side, change both.
//
// Run: 1) build, 2) node test/transcript-mcp-marker-format.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("tmf-home-");
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { parseTranscriptFile } = await import("../dist/pty/claude-transcript.js");

// COPIES of packages/web/src/lib/mcpActivity.ts CALL_LINE / RESULT_HEAD — keep byte-identical.
const CALL_LINE = /^\[tool\](?: \{([^}]*)\})? mcp__loom-([a-z0-9-]+)__([A-Za-z0-9_]+)\((.*)\)$/;
const RESULT_HEAD = /^-> tool result(?: \{([^}]*)\})?( \(error\))?(?:: ([\s\S]*))?$/;

const OK_ID = "toolu_01AAAAAAAAAAAAAAAokay123";
const ERR_ID = "toolu_01BBBBBBBBBBBBBBerrr4567";
const BASH_ID = "toolu_01CCCCCCCCCCCCCCbash8901";

const lines = [
  { type: "user", message: { role: "user", content: "go" } },
  { type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "checking" },
    { type: "tool_use", id: OK_ID, name: "mcp__loom-tasks__tasks_get", input: { id: "abcd1234" } },
    { type: "tool_use", id: ERR_ID, name: "mcp__loom-orchestration__worker_report", input: { status: "done" } },
    { type: "tool_use", id: BASH_ID, name: "Bash", input: { command: "ls" } },
  ] } },
  { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: OK_ID, content: [{ type: "text", text: '{"ok":true}' }] },
    { type: "tool_result", tool_use_id: ERR_ID, is_error: true, content: "refused: nope" },
    { type: "tool_result", tool_use_id: BASH_ID, content: "file.txt" },
  ] } },
];
const dir = mkdtempManaged("loom-tmf-");
const file = path.join(dir, "t.jsonl");
fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const turns = parseTranscriptFile(file);
check("three turns: user, assistant, tool_result", turns.map((t) => t.role).join(",") === "user,assistant,tool_result");

const callLines = turns[1].text.split("\n");
check("exact MCP call line (ok)", callLines.includes('[tool] {Aokay123} mcp__loom-tasks__tasks_get({"id":"abcd1234"})'));
check("exact MCP call line (error one)", callLines.includes('[tool] {errr4567} mcp__loom-orchestration__worker_report({"status":"done"})'));
check("non-MCP call line keeps the marker", callLines.includes('[tool] {bash8901} Bash({"command":"ls"})'));

const m1 = CALL_LINE.exec('[tool] {Aokay123} mcp__loom-tasks__tasks_get({"id":"abcd1234"})');
const callMatches = callLines.map((l) => CALL_LINE.exec(l)).filter(Boolean);
check("web CALL_LINE matches exactly the two Loom MCP calls (not Bash)", callMatches.length === 2);
check("CALL_LINE captures tag/router/tool/args", !!m1 && m1[1] === "Aokay123" && m1[2] === "tasks" && m1[3] === "tasks_get" && m1[4] === '{"id":"abcd1234"}');
check("CALL_LINE args JSON-parse", callMatches.every((m) => { try { JSON.parse(m[4]); return true; } catch { return false; } }));

const resLines = turns[2].text.split("\n");
check("exact ok result line", resLines.includes('-> tool result {Aokay123}: {"ok":true}'));
check("exact error result line", resLines.includes("-> tool result {errr4567} (error): refused: nope"));
check("non-MCP result line keeps the marker", resLines.includes("-> tool result {bash8901}: file.txt"));
const ok = RESULT_HEAD.exec('-> tool result {Aokay123}: {"ok":true}');
const er = RESULT_HEAD.exec("-> tool result {errr4567} (error): refused: nope");
check("RESULT_HEAD ok: tag, no error flag, body", !!ok && ok[1] === "Aokay123" && !ok[2] && ok[3] === '{"ok":true}');
check("RESULT_HEAD error: tag, error flag, body", !!er && er[1] === "errr4567" && !!er[2] && er[3] === "refused: nope");
check("call tags pair with result tags", callMatches.every((m) => resLines.some((l) => l.startsWith("-> tool result") && RESULT_HEAD.exec(l)?.[1] === m[1])));

await finishAndExit(failures === 0 ? 0 : 1);
