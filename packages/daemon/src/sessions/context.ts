import fs from "node:fs";
import { engineTranscriptPath } from "./transcript.js";

export interface ContextStats {
  /** Tokens the model carried as INPUT on the most recent turn ≈ current context occupancy. */
  inputTokens: number;
  /** Assistant turns so far (coarse secondary signal). */
  turns: number;
  /** Model id from the most recent assistant line (e.g. "claude-opus-4-8"); null if absent. */
  model: string | null;
}

function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/**
 * Measure a session's current engine-context occupancy by tail-scanning its transcript JSONL.
 * The LAST assistant turn's `usage` approximates how much the model is now carrying as input:
 * input_tokens + cache_read + cache_creation (the cache fields hold the bulk of a warm context).
 * `turns` counts assistant lines (with a message) as a coarse secondary signal.
 * Returns null if the transcript file is missing or no assistant line carries usage.
 */
export function readContextStats(cwd: string, engineSessionId: string): ContextStats | null {
  const file = engineTranscriptPath(cwd, engineSessionId);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; } // missing transcript

  let turns = 0;
  let lastUsage: Record<string, unknown> | null = null;
  let lastModel: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "assistant" || !o.message) continue;
    turns++;
    const msg = o.message as { usage?: Record<string, unknown>; model?: string };
    if (msg.usage) lastUsage = msg.usage; // keep the most recent turn's usage
    if (typeof msg.model === "string") lastModel = msg.model; // …and its model id
  }

  if (!lastUsage) return null; // assistant lines but none with usage (or no assistant lines)
  const inputTokens =
    num(lastUsage.input_tokens) +
    num(lastUsage.cache_read_input_tokens) +
    num(lastUsage.cache_creation_input_tokens);
  return { inputTokens, turns, model: lastModel };
}
