import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/** Claude encodes a project's transcript dir by replacing : \ / in the cwd with '-'. */
function encodeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[:\\/]/g, "-");
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
  const file = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(cwd), `${engineSessionId}.jsonl`);
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
