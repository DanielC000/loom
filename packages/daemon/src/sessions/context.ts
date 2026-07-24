import fs from "node:fs";
import { engineTranscriptPath, resolveTranscriptFile } from "./transcript.js";

export interface ContextStats {
  /** Tokens the model carried as INPUT on the most recent turn ≈ current context occupancy. */
  inputTokens: number;
  /** Assistant turns so far (coarse secondary signal). */
  turns: number;
  /** Model id from the most recent assistant line (e.g. "claude-opus-4-8"); null if absent. */
  model: string | null;
  /**
   * The LAST assistant turn's TEXT-ONLY reply — concatenated `content[].type==="text"` blocks, with
   * `tool_use` blocks (and any `tool_result`, which only ever appear on a `user`-role line anyway)
   * deliberately excluded. This is exactly what the interactive TUI shows the user as the model's own
   * spoken response. Used by host.ts to scan for the weekly/account usage-cap TEXT sentinel
   * (isWeeklyUsageLimitSentinel) off this SAME single-pass read (card b16320bc review: avoid a second
   * full transcript parse on the Stop hot path) — narrower than a raw-transcript render specifically so
   * a tool call's JSON args or a tool result's file dump can never masquerade as the model's own words.
   * null if no assistant line carries text content.
   */
  lastAssistantText: string | null;
  /**
   * The LAST real (human-submitted) "user"-role turn's raw text — a plain string content is returned
   * verbatim; an array-content turn concatenates its `text` blocks. A `type:"user"` transcript line whose
   * content is ENTIRELY `tool_result` blocks (Claude Code's on-disk encoding for a tool's return value,
   * not anything a human typed — see transcript.ts's `classifyRole`) is skipped, so this always reflects
   * the last turn a human/Loom actually SUBMITTED, not an intervening tool result. Used by host.ts's
   * bare-pasted-text-placeholder tripwire (paste-tripwire.ts) to compare against `live.lastPrompt` — the
   * exact text `submit()` sent — off this SAME single-pass read. null if no such line exists.
   */
  lastUserText: string | null;
}

function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

/** Text-only extraction from an assistant message's `content` array — tool_use/tool_result excluded. */
function textOnlyContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/** True iff `content` is a non-empty array of ONLY `tool_result` blocks (mirrors transcript.ts's classifyRole). */
function isToolResultOnly(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result")
  );
}

/** Raw text of a "user"-role message: a string content verbatim, or array "text" blocks joined. */
function userTurnText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * Measure a session's current engine-context occupancy by tail-scanning its transcript JSONL — ONE
 * single-pass read (card b16320bc review folded the last-assistant-text scan into this SAME loop rather
 * than a second full-file parse, since a long session's JSONL can be multi-MB and this runs on the
 * M2-sensitive synchronous Stop-hook chokepoint).
 * The LAST assistant turn's `usage` approximates how much the model is now carrying as input:
 * input_tokens + cache_read + cache_creation (the cache fields hold the bulk of a warm context).
 * `turns` counts assistant lines (with a message) as a coarse secondary signal.
 * Returns null if the transcript file is missing or no assistant line carries usage.
 *
 * Resolves the file via {@link resolveTranscriptFile} (computed path first, else a scan of
 * `~/.claude/projects/*` by the globally-unique engine session id) rather than the direct computed
 * path alone — card 7c1fc117: the direct path is exposed to the SAME project-dir-encoding-drift class
 * `resolveTranscriptFile` already exists to guard `engineTranscriptExists` against (see its doc), and a
 * miss here used to fail SILENTLY (a caught `readFileSync` ENOENT → `null`), permanently freezing the
 * caller's persisted context counter with zero signal. Defense-in-depth only, not the fix for every
 * freeze cause — see host.ts's SessionStart handler for the OTHER (confirmed, more common) cause: the
 * engine itself rotating to a new transcript file mid-session.
 */
export function readContextStats(cwd: string, engineSessionId: string): ContextStats | null {
  const file = resolveTranscriptFile(cwd, engineSessionId);
  if (!file) return null; // not found at the computed path OR anywhere under ~/.claude/projects
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; } // exists but unreadable (race/permissions)

  let turns = 0;
  let lastUsage: Record<string, unknown> | null = null;
  let lastModel: string | null = null;
  let lastText: string | null = null;
  let lastUserTurnText: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "user" && o.message) {
      const msg = o.message as { content?: unknown };
      if (!isToolResultOnly(msg.content)) {
        const t = userTurnText(msg.content);
        if (t !== null) lastUserTurnText = t; // …the last REAL (non-tool-result) user turn's raw text
      }
      continue;
    }
    if (o.type !== "assistant" || !o.message) continue;
    turns++;
    const msg = o.message as { usage?: Record<string, unknown>; model?: string; content?: unknown };
    if (msg.usage) lastUsage = msg.usage; // keep the most recent turn's usage
    if (typeof msg.model === "string") lastModel = msg.model; // …and its model id
    const text = textOnlyContent(msg.content);
    if (text !== null) lastText = text; // …and its text-only reply (independent of whether usage was present)
  }

  if (!lastUsage) return null; // assistant lines but none with usage (or no assistant lines)
  const inputTokens =
    num(lastUsage.input_tokens) +
    num(lastUsage.cache_read_input_tokens) +
    num(lastUsage.cache_creation_input_tokens);
  return { inputTokens, turns, model: lastModel, lastAssistantText: lastText, lastUserText: lastUserTurnText };
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
 * Mutable running total that folds a transcript's assistant lines into a cumulative RunUsageStats. Kept
 * as a struct (not a closure) so the SAME per-line fold is shared by both the full-file `readRunUsageFromFile`
 * and the incremental `IncrementalRunUsageReader` — this is what makes the incremental cumulative
 * BYTE-IDENTICAL to a full parse by construction (identical per-line semantics, identical whole-file dedup).
 * `seen` (the message.id dedup set) is part of the accumulator precisely so it can PERSIST across
 * incremental chunks — a duplicate line-group that straddles a chunk boundary is still counted once.
 */
interface UsageAccumulator {
  /** message.ids already counted — dedup spans the WHOLE file (and, incrementally, ALL prior chunks). */
  seen: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turns: number;
  /** Last assistant model seen (set from ANY assistant line with a model, even one without usage). */
  model: string | null;
  /** True once ≥1 usage-bearing line has been counted — gates the null return (no usage → null). */
  sawUsage: boolean;
}

function newUsageAccumulator(): UsageAccumulator {
  return { seen: new Set<string>(), inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0, model: null, sawUsage: false };
}

/**
 * Fold ONE transcript JSONL line into `acc`. The single source of truth for the dedup-by-message.id +
 * per-field summing — reused verbatim by the full and incremental readers so they can never drift. Blank
 * lines, non-JSON, and non-assistant lines are no-ops (matching the original loop's `continue`s).
 */
function accumulateUsageLine(acc: UsageAccumulator, line: string): void {
  if (!line.trim()) return;
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return; }
  if (o.type !== "assistant" || !o.message) return;
  const msg = o.message as { id?: unknown; usage?: Record<string, unknown>; model?: string };
  if (typeof msg.model === "string") acc.model = msg.model; // last assistant model wins (matches readContextStats)
  if (!msg.usage) return;
  const id = typeof msg.id === "string" ? msg.id : null;
  if (id != null) { if (acc.seen.has(id)) return; acc.seen.add(id); } // dedupe split lines sharing one message id
  acc.sawUsage = true;
  acc.turns++;
  acc.inputTokens += num(msg.usage.input_tokens);
  acc.outputTokens += num(msg.usage.output_tokens);
  acc.cacheCreationTokens += num(msg.usage.cache_creation_input_tokens);
  acc.cacheReadTokens += num(msg.usage.cache_read_input_tokens);
}

/** Project the accumulator's running totals into an immutable RunUsageStats snapshot. */
function statsFromAccumulator(acc: UsageAccumulator): RunUsageStats {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens,
    turns: acc.turns,
    model: acc.model,
  };
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
 *
 * SYNCHRONOUS + whole-file: still used by the boot backfill + Agent-Runs cost readout (NOT the sampler
 * hot path). The sampler tick uses {@link IncrementalRunUsageReader}, which returns a cumulative
 * byte-identical to this via the shared {@link accumulateUsageLine} fold.
 */
export function readRunUsageFromFile(file: string): RunUsageStats | null {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; } // missing transcript
  const acc = newUsageAccumulator();
  for (const line of raw.split("\n")) accumulateUsageLine(acc, line);
  if (!acc.sawUsage) return null;
  return statsFromAccumulator(acc);
}

/** Cumulative run usage from a session's COMPUTED engine-transcript path (cwd + engine id). */
export function readRunUsage(cwd: string, engineSessionId: string): RunUsageStats | null {
  return readRunUsageFromFile(engineTranscriptPath(cwd, engineSessionId));
}

/** Per-session incremental parse state — carried across ticks so each tick only parses APPENDED bytes. */
interface IncrementalUsageCache {
  /** The engine transcript this cache tracks; a change ⇒ fork/recycle rotated to a new file ⇒ reset. */
  engineSessionId: string;
  /** Bytes consumed as COMPLETE lines — always a `\n` boundary (never mid-line, so never mid-multibyte-char). */
  offset: number;
  /** Raw trailing bytes past `offset` that don't yet end in `\n` — a partial line buffered for next tick. */
  partialBytes: Buffer;
  /** Running cumulative (incl. the message.id dedup `seen` set) — PERSISTED across ticks; the straddle guard. */
  acc: UsageAccumulator;
}

/**
 * INCREMENTAL + ASYNC cumulative usage reader for the sampler hot path (LAYER 1). Produces, per session, a
 * cumulative RunUsageStats BYTE-IDENTICAL to what a full {@link readRunUsageFromFile} would return — but by
 * parsing only the bytes APPENDED since the last tick, off the event loop (`fs.promises`), instead of
 * re-reading + re-parsing every live session's WHOLE transcript synchronously each tick (the fleet-scale
 * event-loop stall this replaces). Because the cumulative is identical to a full parse, the sampler's delta
 * layer (`recordDelta`) — including the restart-double-count fix — is preserved unchanged by construction.
 *
 * Per-session cache holds { engineSessionId, offset (at a `\n` boundary), partialBytes, acc (running totals
 * + the dedup `seen` set) }. Each tick, for a session:
 *  • `fs.promises.stat` the transcript; missing/unreadable ⇒ null (skip), cache untouched.
 *  • size === last-read end (offset + partial length) ⇒ no new bytes ⇒ cumulative unchanged (no IO/parse).
 *  • size < last-read end ⇒ truncation/shrink of THIS file ⇒ RESET the cache and re-read from 0.
 *  • engineSessionId changed vs cache ⇒ fork/recycle rotated to a NEW transcript ⇒ RESET and read the new file.
 *  • else read ONLY [lastReadEnd, size), PREPEND the cached partialBytes, split on `\n`, parse only the
 *    COMPLETE lines (advancing offset by their bytes), and buffer the trailing no-newline remainder.
 *
 * The dedup `seen` set lives in the cache and is cleared ONLY on rotation/reset — so a duplicate message.id
 * line-group straddling a tick's offset boundary is counted exactly ONCE, never re-counted (the load-bearing
 * over-count trap). UTF-8 safe: offset advances only to a `\n` (0x0A never appears inside a multibyte
 * sequence) and the partial line is buffered as raw BYTES (a multibyte char split across a chunk is never
 * decoded until complete).
 *
 * IN-MEMORY (per UsageSampler instance): a daemon restart constructs a fresh reader ⇒ empty cache ⇒ the
 * first tick full-parses ⇒ the same cumulative as today ⇒ the DB-aware first-sight path runs identically.
 */
export class IncrementalRunUsageReader {
  private cache = new Map<string, IncrementalUsageCache>();

  /**
   * Return `sessionId`'s current cumulative transcript usage, parsing only newly-appended bytes since the
   * last call. `cwd`+`engineSessionId` resolve the file exactly like {@link readRunUsage}. Never rejects —
   * any IO error resolves to the last-known cumulative (or null if nothing usage-bearing has been seen).
   */
  async read(sessionId: string, cwd: string, engineSessionId: string): Promise<RunUsageStats | null> {
    const file = engineTranscriptPath(cwd, engineSessionId);
    let entry = this.cache.get(sessionId);
    // Rotation (fork/recycle): the session moved to a brand-new engine transcript → drop the stale cache.
    if (entry && entry.engineSessionId !== engineSessionId) { this.cache.delete(sessionId); entry = undefined; }

    let size: number;
    try { size = (await fs.promises.stat(file)).size; }
    catch { return entry && entry.acc.sawUsage ? statsFromAccumulator(entry.acc) : null; } // missing/unreadable → skip

    if (!entry) {
      entry = { engineSessionId, offset: 0, partialBytes: Buffer.alloc(0), acc: newUsageAccumulator() };
      this.cache.set(sessionId, entry);
    }
    let lastReadEnd = entry.offset + entry.partialBytes.length; // where the previous read stopped (= prior size)
    if (size < lastReadEnd) {
      // Truncation/shrink of the same file → the byte offsets are meaningless → reset + full re-read from 0.
      entry = { engineSessionId, offset: 0, partialBytes: Buffer.alloc(0), acc: newUsageAccumulator() };
      this.cache.set(sessionId, entry);
      lastReadEnd = 0;
    }
    if (size === lastReadEnd) return entry.acc.sawUsage ? statsFromAccumulator(entry.acc) : null; // no new bytes

    const len = size - lastReadEnd;
    const buf = Buffer.alloc(len);
    let got = 0;
    try {
      const fh = await fs.promises.open(file, "r");
      try {
        // FileHandle.read is a single `pread` — a POSIX short read can return FEWER than `len` bytes,
        // leaving the buffer tail zero-filled. Loop until `len` is filled so we never account bytes we
        // didn't read (silent undercount + mid-message JSON corruption); stop on 0 (EOF/concurrent shrink)
        // and carry ONLY the bytes actually read — the remainder is re-read on the next tick.
        while (got < len) {
          const { bytesRead } = await fh.read(buf, got, len - got, lastReadEnd + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
      } finally { await fh.close(); }
    } catch { return entry.acc.sawUsage ? statsFromAccumulator(entry.acc) : null; } // read failed → skip this tick

    // Prepend the buffered partial line, then split on the LAST newline: everything up to it is complete
    // lines (parse them, advance offset by their bytes); the remainder is the next partial (buffer as bytes).
    // `got` may be < `len` on a truncating read — only the bytes actually read are folded in.
    const combined = Buffer.concat([entry.partialBytes, got === len ? buf : buf.subarray(0, got)]);
    const lastNl = combined.lastIndexOf(0x0A);
    if (lastNl === -1) {
      entry.partialBytes = combined; // still no complete line — buffer everything, offset unchanged
    } else {
      const complete = combined.subarray(0, lastNl + 1);
      entry.partialBytes = combined.subarray(lastNl + 1);
      entry.offset += complete.length;
      for (const line of complete.toString("utf8").split("\n")) accumulateUsageLine(entry.acc, line);
    }
    return entry.acc.sawUsage ? statsFromAccumulator(entry.acc) : null;
  }

  /** Drop ONE session's cache entry (on session exit — it never ticks again). Mirrors `lastSeen.delete`. */
  drop(sessionId: string): void { this.cache.delete(sessionId); }

  /** Clear ALL cached state (the corrective reset — force a fresh full parse on the next tick). */
  clear(): void { this.cache.clear(); }
}
