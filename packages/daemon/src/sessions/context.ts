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

/** Cumulative usage summed across ALL of a run's turns (Agent Runs #2 — the per-run cost meter source). */
export interface RunUsageStats {
  /** Cumulative BILLED input tokens (Σ input_tokens across turns) — NOT cache (priced separately). */
  inputTokens: number;
  /** Cumulative billed OUTPUT tokens (Σ output_tokens). */
  outputTokens: number;
  /** Cumulative cache-CREATION (write) tokens (Σ cache_creation_input_tokens). */
  cacheCreationTokens: number;
  /** Cumulative cache-READ tokens (Σ cache_read_input_tokens). */
  cacheReadTokens: number;
  /** Number of distinct assistant turns counted (deduped by message id). */
  turns: number;
  /** Model id from the last assistant line carrying one (sizes the per-model price). */
  model: string | null;
}

/**
 * Sum a run's CUMULATIVE engine usage by full-scanning its transcript JSONL at `file`. A run is an
 * ephemeral single-purpose session, so its turns are its whole life — summing every assistant turn's
 * `usage` gives genuine billed totals (input + output + cache), unlike `readContextStats` which reads
 * only the last turn's occupancy.
 *
 * CRITICAL (verified against real run transcripts): the engine writes ONE assistant message as MULTIPLE
 * JSONL lines (e.g. a `thinking` line and a `tool_use` line), each repeating the SAME `message.id` and
 * the SAME `usage` block. Summing naïvely double-counts. So we DEDUPE by `message.id` — each id counts
 * exactly once. Lines without an id (shouldn't happen) fall back to counting individually. Returns null
 * if the file is missing or no assistant line carries usage.
 */
export function readRunUsageFromFile(file: string): RunUsageStats | null {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; } // missing transcript
  const seen = new Set<string>();
  let inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0, turns = 0;
  let model: string | null = null;
  let sawUsage = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "assistant" || !o.message) continue;
    const msg = o.message as { id?: unknown; usage?: Record<string, unknown>; model?: string };
    if (typeof msg.model === "string") model = msg.model; // last assistant model wins (matches readContextStats)
    if (!msg.usage) continue;
    const id = typeof msg.id === "string" ? msg.id : null;
    if (id != null) { if (seen.has(id)) continue; seen.add(id); } // dedupe split lines sharing one message id
    sawUsage = true;
    turns++;
    inputTokens += num(msg.usage.input_tokens);
    outputTokens += num(msg.usage.output_tokens);
    cacheCreationTokens += num(msg.usage.cache_creation_input_tokens);
    cacheReadTokens += num(msg.usage.cache_read_input_tokens);
  }
  if (!sawUsage) return null;
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, turns, model };
}

/** Cumulative run usage from a session's COMPUTED engine-transcript path (cwd + engine id). */
export function readRunUsage(cwd: string, engineSessionId: string): RunUsageStats | null {
  return readRunUsageFromFile(engineTranscriptPath(cwd, engineSessionId));
}
