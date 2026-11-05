// ─────────────────────────────────────────────────────────────────────────────────────────────
// transcript-token-composition.mjs — card 02cc2fbb: a residency-weighted token-composition report
// over Claude Code engine transcripts (the before/after INSTRUMENT for the token-reduction cards).
// Reproduces the §2 tables of the 65e1fc5d research for a given transcript root, project and window.
//
// @decision 02cc2fbb — keep this read-only over transcripts and out of STATIC_GUARD_REPO_PATHS: its
// numbers are host-local data, so they are an instrument, never a gating verdict.
//
// READ-ONLY: it only ever reads `*.jsonl` transcript files under --root. It never opens the Loom
// DB, never writes anything, never spawns a process. It defaults to nothing (--root is REQUIRED).
//
// RUN:
//   node packages/daemon/scripts/transcript-token-composition.mjs --root=<~/.claude/projects>
//        [--project=<substring of a project dir name, e.g. the Loom project id>]
//        [--days=7 | --since=<ISO> --until=<ISO>] [--max-sessions=300] [--json]
//
// METHOD (also printed in every report):
//   * Window: top-level transcripts (no subagent dirs) whose file mtime is inside the window, newest
//     first, capped at --max-sessions.
//   * API calls: assistant records de-duplicated by message.id (one call is written as several
//     records, one per content block). Context size of a call = usage.input_tokens +
//     cache_read_input_tokens + cache_creation_input_tokens.
//   * DENOMINATOR: the sum of that context size over every counted call = "all input tokens".
//   * Residency weight: a block's chars x the number of LATER API calls in the same session (the
//     call that the block first appears in front of onward). Tokens = chars / 4 (an approximation).
//     Shares are residency-weighted chars/4 divided by the denominator.
//   * First-call baseline: the context size of each session's FIRST call x that session's call
//     count, as a share of the denominator. Kickoff-resident parts (CLAUDE.md, project-memory
//     digest) are a char-based attribution INSIDE that baseline, not additive to it.
//   * Cache rebuild: a non-first call whose cache_creation_input_tokens exceeds --rebuild-tokens
//     (default 50000).
//   * Images are excluded from char counts. No compaction-boundary handling (none seen in the research).
// ─────────────────────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_REBUILD_TOKENS = 50_000;

/** Characters of a content value (string, or array of text-bearing blocks); images count 0. */
export function charsOf(v) {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce((n, b) => n + charsOf(b), 0);
  if (typeof v === "object") {
    if (v.type === "image") return 0;
    if (typeof v.text === "string") return v.text.length;
    if (v.content !== undefined) return charsOf(v.content);
    return JSON.stringify(v).length;
  }
  return String(v).length;
}

function toolBucket(name) {
  if (!name) return "otherTool";
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "Bash" || name === "PowerShell") return "bash";
  if (name === "Read") return "read";
  if (name === "Grep" || name === "Glob") return "grep";
  if (name === "Skill") return "skillCall";
  return "otherTool";
}

/** Splits a text block into [claudeMd, memoryDigest, rest] char counts (attribution inside the baseline). */
export function attributeKickoffText(text) {
  let claudeMd = 0;
  let memory = 0;
  const re = /Contents of [^\n]*CLAUDE\.md[^\n]*:\n([\s\S]*?)(?=\nContents of |<\/system-reminder>)/g;
  let m;
  while ((m = re.exec(text)) !== null) claudeMd += m[1].trimEnd().length;
  const mi = text.indexOf("[loom:project-memory]");
  if (mi >= 0) {
    const end = text.indexOf("</pasted_content", mi);
    memory = (end >= 0 ? end : text.length) - mi;
  }
  return { claudeMd, memory };
}

/** Analyze ONE transcript's text. Returns per-session tallies (see aggregate()). */
export function analyzeSession(raw, opts = {}) {
  const rebuildTokens = opts.rebuildTokens ?? DEFAULT_REBUILD_TOKENS;
  const seen = new Set();
  const calls = []; // {ctx, create, model}
  const toolNames = new Map(); // tool_use_id -> tool name
  const blocks = []; // {bucket, chars, callsBefore}
  let kickoff = { claudeMd: 0, memory: 0, chars: 0 };
  let sawFirstCall = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // torn trailing line from a live session
    }
    if (o.isSidechain) continue;
    const msg = o.message;
    if (o.type === "attachment" && !sawFirstCall && Array.isArray(o.rendered)) {
      // Real transcripts carry CLAUDE.md / the memory index as pre-first-call attachment records.
      for (const r of o.rendered) {
        const t = typeof r?.content === "string" ? r.content : "";
        const a = attributeKickoffText(t);
        kickoff = { claudeMd: kickoff.claudeMd + a.claudeMd, memory: kickoff.memory + a.memory, chars: kickoff.chars + t.length };
      }
    } else if (o.type === "assistant" && msg && typeof msg === "object") {
      const u = msg.usage;
      const id = msg.id;
      const isNewCall = u && id && !seen.has(id);
      if (isNewCall) {
        seen.add(id);
        const create = u.cache_creation_input_tokens ?? 0;
        calls.push({
          ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + create,
          create,
          model: msg.model ?? "unknown",
        });
        sawFirstCall = true;
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b.type === "tool_use") {
          toolNames.set(b.id, b.name);
          blocks.push({ bucket: "toolInput", chars: charsOf(b.input), callsBefore: calls.length });
        } else if (b.type === "text") {
          blocks.push({ bucket: "assistantText", chars: charsOf(b.text), callsBefore: calls.length });
        }
      }
    } else if (o.type === "user" && msg && typeof msg === "object") {
      const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
      for (const b of content) {
        if (b.type === "tool_result") {
          let bucket = toolBucket(toolNames.get(b.tool_use_id));
          if (bucket === "skillCall") bucket = "skill";
          blocks.push({ bucket, chars: charsOf(b.content), callsBefore: calls.length });
        } else if (b.type === "text") {
          const t = b.text ?? "";
          if (!sawFirstCall) {
            const a = attributeKickoffText(t);
            kickoff = { claudeMd: kickoff.claudeMd + a.claudeMd, memory: kickoff.memory + a.memory, chars: kickoff.chars + t.length };
          } else if (t.startsWith("Base directory for this skill")) {
            blocks.push({ bucket: "skill", chars: t.length, callsBefore: calls.length });
          } else {
            blocks.push({ bucket: "userText", chars: t.length, callsBefore: calls.length });
          }
        }
      }
    }
  }
  const n = calls.length;
  const char = {};
  for (const b of blocks) {
    if (b.callsBefore === 0) continue; // before the first call: part of the baseline, not a turn
    const later = n - b.callsBefore;
    if (later <= 0) continue;
    char[b.bucket] = (char[b.bucket] ?? 0) + b.chars * later;
  }
  const models = {};
  for (const c of calls) models[c.model] = (models[c.model] ?? 0) + 1;
  return {
    calls: n,
    inputTokens: calls.reduce((s, c) => s + c.ctx, 0),
    firstCallCtx: n ? calls[0].ctx : 0,
    rebuilds: calls.slice(1).filter((c) => c.create > rebuildTokens).length,
    charTurns: char,
    kickoffCharTurns: { claudeMd: kickoff.claudeMd * n, memory: kickoff.memory * n, kickoff: kickoff.chars * n },
    models,
  };
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Combine per-session results into the report object. */
export function aggregate(sessions) {
  const live = sessions.filter((s) => s.calls > 0);
  const totalCalls = live.reduce((s, x) => s + x.calls, 0);
  const denom = live.reduce((s, x) => s + x.inputTokens, 0);
  const charTurns = {};
  const kick = { claudeMd: 0, memory: 0, kickoff: 0 };
  const models = {};
  for (const s of live) {
    for (const [k, v] of Object.entries(s.charTurns)) charTurns[k] = (charTurns[k] ?? 0) + v;
    for (const k of Object.keys(kick)) kick[k] += s.kickoffCharTurns[k];
    for (const [k, v] of Object.entries(s.models)) models[k] = (models[k] ?? 0) + v;
  }
  const share = (chars) => (denom ? chars / CHARS_PER_TOKEN / denom : 0);
  const baseline = live.reduce((s, x) => s + x.firstCallCtx * x.calls, 0);
  return {
    sessions: live.length,
    calls: totalCalls,
    denominatorInputTokens: denom,
    medianFirstCallTokens: median(live.map((s) => s.firstCallCtx)),
    meanContextPerCall: totalCalls ? denom / totalCalls : 0,
    medianCallsPerSession: median(live.map((s) => s.calls)),
    firstCallShare: denom ? baseline / denom : 0,
    cacheRebuilds: live.reduce((s, x) => s + x.rebuilds, 0),
    shares: Object.fromEntries(Object.entries(charTurns).map(([k, v]) => [k, share(v)])),
    baselineAttribution: { claudeMd: share(kick.claudeMd), memoryDigest: share(kick.memory), kickoffTotal: share(kick.kickoff) },
    models,
  };
}

/** Collect top-level transcript files under root whose dir name contains `project`, mtime in window. */
export function listTranscripts({ root, project, sinceMs, untilMs, maxSessions }) {
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || (project && !d.name.includes(project))) continue;
    const dir = path.join(root, d.name);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const p = path.join(dir, f.name);
      const mtime = fs.statSync(p).mtimeMs;
      if (mtime >= sinceMs && mtime <= untilMs) out.push({ p, mtime });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { total: out.length, files: out.slice(0, maxSessions).map((x) => x.p) };
}

const pct = (x) => (x * 100).toFixed(1) + "%";

export function formatReport(r, ctx) {
  const L = [];
  L.push("Transcript token-composition report (residency-weighted)");
  L.push(`Window:      ${new Date(ctx.sinceMs).toISOString()} .. ${new Date(ctx.untilMs).toISOString()} (file mtime)`);
  L.push(`Root:        ${ctx.root}   Project filter: ${ctx.project || "(none)"}`);
  L.push(`Sample:      ${r.sessions} sessions analysed of ${ctx.total} in window (cap --max-sessions=${ctx.maxSessions}); ${r.calls} API calls`);
  L.push(`Denominator: ${r.denominatorInputTokens} input tokens = sum over calls of (input + cache_read + cache_creation)`);
  L.push("Method:      chars/4 tokens; residency weight = chars x later API calls in the same session; calls de-duplicated by message.id;");
  L.push("             images excluded; subagent transcripts excluded; baseline = first-call context x session call count.");
  L.push("");
  L.push(`Median first-call context:      ${Math.round(r.medianFirstCallTokens)} tokens`);
  L.push(`Mean context per call:          ${Math.round(r.meanContextPerCall)} tokens`);
  L.push(`Median calls per session:       ${r.medianCallsPerSession}`);
  L.push(`First-call share of all input:  ${pct(r.firstCallShare)}`);
  L.push(`Cache rebuilds (>${ctx.rebuildTokens} write, non-first call): ${r.cacheRebuilds} of ${r.calls}`);
  L.push("");
  L.push("Residency-weighted share of all input tokens, by source:");
  for (const [k, v] of Object.entries(r.shares).sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(14)} ${pct(v)}`);
  L.push("Inside the first-call baseline (char attribution, not additive):");
  L.push(`  CLAUDE.md      ${pct(r.baselineAttribution.claudeMd)}`);
  L.push(`  memory digest  ${pct(r.baselineAttribution.memoryDigest)}`);
  L.push(`  whole kickoff  ${pct(r.baselineAttribution.kickoffTotal)}`);
  L.push("");
  L.push("Model mix (calls):");
  for (const [k, v] of Object.entries(r.models).sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(28)} ${v}`);
  return L.join("\n");
}

function parseArgs(argv) {
  const a = {};
  for (const x of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(x);
    if (m) a[m[1]] = m[2] ?? true;
  }
  return a;
}

export function run(argv) {
  const a = parseArgs(argv);
  if (!a.root || a.root === true) throw new Error("--root=<transcript root, e.g. ~/.claude/projects> is required");
  const untilMs = a.until ? Date.parse(a.until) : Date.now();
  const days = a.days ? Number(a.days) : 7;
  const sinceMs = a.since ? Date.parse(a.since) : untilMs - days * 86_400_000;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) throw new Error("bad --since/--until/--days");
  const maxSessions = a["max-sessions"] ? Number(a["max-sessions"]) : 300;
  const rebuildTokens = a["rebuild-tokens"] ? Number(a["rebuild-tokens"]) : DEFAULT_REBUILD_TOKENS;
  const { total, files } = listTranscripts({ root: a.root, project: a.project === true ? "" : a.project, sinceMs, untilMs, maxSessions });
  const sessions = files.map((f) => analyzeSession(fs.readFileSync(f, "utf8"), { rebuildTokens }));
  const report = aggregate(sessions);
  const ctx = { root: a.root, project: a.project === true ? "" : a.project, sinceMs, untilMs, total, maxSessions, rebuildTokens };
  return a.json ? JSON.stringify({ ctx, report }, null, 2) : formatReport(report, ctx);
}

// Full-path comparison (not basename): the same-named test file imports this module and must not run main.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
