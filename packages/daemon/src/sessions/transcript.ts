import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Claude encodes a project's transcript dir by replacing EVERY non-alphanumeric char in the cwd
 * with '-' (verified against real `~/.claude/projects` dirs: `C:\…` → `C--…`, `tmp.x` → `tmp-x`,
 * `immo_trend` → `immo-trend`). The old version only replaced `:\/` — so any cwd with a `.` or `_`
 * (e.g. a worktree under `~/.loom`, or an underscored repo) computed the WRONG dir and transcript
 * reads silently returned nothing. `resolveTranscriptFile` adds a scan fallback so a future
 * encoding change can't re-break this (the engine session id is globally unique).
 */
export function encodeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to a session's engine transcript JSONL on disk (the COMPUTED/expected path). */
export function engineTranscriptPath(cwd: string, engineSessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectDir(cwd), `${engineSessionId}.jsonl`);
}

/**
 * Locate a session's transcript file robustly: the computed path first (fast, correct for the
 * common case), else scan `~/.claude/projects/*` for `<engineSessionId>.jsonl` — the id is a
 * globally-unique UUID, so a match is unambiguous regardless of how Claude encoded the dir. This
 * makes transcript reads resilient to any future dir-encoding drift. Returns null if not found.
 */
function resolveTranscriptFile(cwd: string, engineSessionId: string): string | null {
  const direct = engineTranscriptPath(cwd, engineSessionId);
  if (fs.existsSync(direct)) return direct;
  const root = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const dir of fs.readdirSync(root)) {
      const f = path.join(root, dir, `${engineSessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* projects dir missing — nothing to find */ }
  return null;
}

/** Whether a session is still resumable (its engine transcript file still exists). */
export function engineTranscriptExists(cwd: string, engineSessionId: string): boolean {
  return resolveTranscriptFile(cwd, engineSessionId) !== null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "tool_use") parts.push(`⚙ tool: ${String(c.name ?? "")}(${JSON.stringify(c.input ?? {}).slice(0, 200)})`);
    else if (c.type === "tool_result") parts.push("↳ tool result");
  }
  return parts.join("\n");
}

/**
 * Render Claude's session JSONL into a clean, ordered transcript — the canonical
 * "read past conversation" surface (terminal scrollback is best-effort live-only).
 */
export function readTranscript(cwd: string, engineSessionId: string): TranscriptTurn[] {
  const file = resolveTranscriptFile(cwd, engineSessionId);
  if (!file) return [];
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue; // skip system/meta/summary
    const msg = o.message as { content?: unknown } | undefined;
    const text = extractText(msg?.content);
    if (text.trim()) turns.push({ role: o.type, text });
  }
  return turns;
}
