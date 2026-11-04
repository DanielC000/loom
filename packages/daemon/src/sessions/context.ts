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

/** True iff `content` is a non-empty array of ONLY `tool_result` blocks (mirrors transcript.ts's classifyRole).
 *  Exported (card 5d068eec) so `pty/host.ts`'s give-up transcript-growth corroboration can reuse the SAME
 *  "is this user line real, or just a tool result" rule this module already established, rather than a
 *  second independent copy drifting from it. */
export function isToolResultOnly(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result")
  );
}

/** Raw text of a "user"-role message: a string content verbatim, or array "text" blocks joined. Exported
 *  (card 5d068eec) for the same reuse reason as {@link isToolResultOnly}. */
export function userTurnText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * Measure a session's current engine-context occupancy by reading its ENTIRE transcript JSONL — ONE
 * single-pass whole-file read + per-line `JSON.parse`, O(file size) in both (card b16320bc review folded
 * the last-assistant-text scan into this SAME loop rather than a second full-file parse, since a long
 * session's JSONL can be multi-MB and this runs on the M2-sensitive synchronous Stop-hook chokepoint —
 * that review halved the CONSTANT, it did not change the ORDER).
 *
 * ⚠️ NOT a tail-scan, despite the name this once had (card 21a77e85 — filed after the earlier "cheap
 * tail-read" framing here and at the call site turned out false; `:91`/`:98` read + parse every line).
 * A genuine BOUNDED tail-scan is not implementable for this function's contract: `turns` is a count of
 * assistant lines across the WHOLE session (a windowed read would silently undercount every turn outside
 * the window, not approximate it), and `lastUserTurnText` skips every tool-result-only "user" line to
 * find the last REAL human-submitted turn — which a long single agentic exchange (many tool calls, no new
 * human input) can push arbitrarily far from EOF. Measured on a real 8.4 MB / 688-line transcript on this
 * host: the last real user turn sat at line 21 — 97% of the file (666 lines) was tool traffic emitted
 * AFTER it, well past any plausible fixed-size tail window. Re-measured whole-file cost on 7 real
 * transcripts on this host (20 KB → 0.5 ms … 8.4 MB → 44 ms, ~linear) — comparable order of magnitude to
 * the original 25.8 KB → 0.5 ms / 6.6 MB → 103 ms finding; both are ~two orders of magnitude below the
 * ~40s give-up/park budget, so this cost is real but not what drives a park (see card 21a77e85's own
 * §BOUND).
 * The LAST assistant turn's `usage` approximates how much the model is now carrying as input:
 * input_tokens + cache_read + cache_creation (the cache fields hold the bulk of a warm context).
 * `turns` counts assistant lines (with a message) as a coarse secondary signal.
 * Returns null if the transcript file is missing or no assistant line carries usage.
 *
 * @decision 7c1fc117 — resolves via {@link resolveTranscriptFile}, not the bare computed path alone — a
 * miss on the bare path used to fail SILENTLY and permanently freeze the persisted context counter with
 * zero signal. Defense-in-depth only; see host.ts's SessionStart handler for the other, more common cause.
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
    // Claude Code injects a SYNTHETIC assistant-role line on a transient API error — not a real model
    // turn: model:"<synthetic>", an all-zero (but truthy) usage object, and `isApiErrorMessage:true` on
    // the raw line itself. Discriminate on `isApiErrorMessage` rather than `message.model==="<synthetic>"`:
    // it's the CLI's own purpose-built flag for exactly this condition, whereas the "<synthetic>" model
    // sentinel is a broader "no real model call happened" marker the CLI is not confirmed to reserve for
    // API errors alone — using it here risks silently skipping some OTHER synthetic-but-legitimate line.
    // (Single measured specimen — see card 73263d73 — so treat this as the precise, narrowly-scoped
    // discriminator rather than a verified-exhaustive one.) Skipped from `lastUsage`/`lastModel`/`lastText`
    // AND `turns`, so neither the last-wins fields nor the running turn count are corrupted by it.
    if (o.isApiErrorMessage === true) continue;
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
 * @decision sha:8591caf8 — still used by the boot backfill + Agent-Runs cost readout (NOT the sampler hot
 * path); the sampler tick uses {@link IncrementalRunUsageReader} instead, which returns a cumulative
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

/**
 * Cumulative run usage for a session, resolved via {@link resolveTranscriptFile} — the computed path
 * first, else the `~/.claude/projects` scan-by-id fallback (card f10a6f40: this used to resolve via the
 * bare {@link engineTranscriptPath} alone, so in exactly the dir-encoding-drift cases the fallback exists
 * to recover from, `readContextStats` (which already routes through `resolveTranscriptFile`) would find
 * the transcript while this sibling silently returned null — no error, no log, the usage number just
 * absent). Both readers now share one resolution strategy.
 */
export function readRunUsage(cwd: string, engineSessionId: string): RunUsageStats | null {
  const file = resolveTranscriptFile(cwd, engineSessionId);
  if (!file) return null;
  return readRunUsageFromFile(file);
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
 * Outcome of one {@link readIncrementalTail} tick, after the caller has already stat'd the file and
 * decided it's worth reading. Exported ONLY so a unit test can exercise {@link readIncrementalTail}
 * directly — neither reader class exposes this shape to its own callers. See that function's own doc for
 * the full contract.
 */
export interface IncrementalTailReadResult {
  /**
   * True iff the file SHRANK since the caller's last read (truncation/rotation-in-place). The caller
   * must reset whatever OTHER per-session state it carries (an accumulator, turns, lastModel, …) to
   * fresh — `offset`/`partialBytes`/`lines` below already reflect a re-read of the WHOLE current file
   * from byte 0, so they're ready to apply as-is once that reset happens.
   */
  truncated: boolean;
  /** The new offset — REPLACES the caller's own `offset` in full (always a `\n` boundary). */
  offset: number;
  /** The new trailing partial-line buffer — REPLACES the caller's own `partialBytes` in full. */
  partialBytes: Buffer;
  /**
   * Complete new JSONL lines this tick, in order — empty when nothing new arrived, when the new bytes
   * are still an unterminated partial line, or when the chunk read itself failed (`readFailed`).
   */
  lines: string[];
  /**
   * True iff the chunk read (the bounded open/read-loop/close below) threw — `lines` is always empty in
   * this case. `offset`/`partialBytes` are still safe to apply verbatim: unchanged from the caller's own
   * prior values when `truncated` is false, or already reset to 0/empty when `truncated` is true — a
   * truncation's reset happens regardless of whether the follow-up read then fails, matching the two
   * readers' original reset-before-attempt ordering (a truncation discards stale totals even if nothing
   * fresh can be read this same tick).
   */
  readFailed: boolean;
}

/**
 * Shared byte-offset / partial-line tail-read plumbing (card 22072f12) — the ~40 lines
 * {@link IncrementalRunUsageReader} and {@link IncrementalContextStatsReader} used to each carry
 * independently. Given `size` (the file's CURRENT length, already stat'd by the caller — this function
 * never stats; the two callers resolve/stat the path very differently, so that stays their own job) and
 * the caller's own prior `priorOffset`/`priorPartialBytes`, reads only the bytes appended since the last
 * tick and splits them into complete JSONL lines + a trailing partial remainder.
 *
 * Each caller still owns its OWN line-handling semantics entirely — this function does not parse a line
 * or decide what counts as a "fresh" one; it only decides WHICH complete lines exist. {@link
 * IncrementalRunUsageReader} dedupes-and-sums via {@link accumulateUsageLine}; {@link
 * IncrementalContextStatsReader} overwrites last-wins via `foldContextLine` — both fold `result.lines`
 * through their own callback after applying `result.offset`/`result.partialBytes` (and, on `truncated`,
 * resetting their own extra state) exactly as before this extraction; this function never calls a fold
 * callback itself, by design, so neither reader's fold semantics live inside shared code.
 *
 * • `size === priorOffset + priorPartialBytes.length` ⇒ no new bytes ⇒ `{truncated:false, lines:[]}`
 *   with `offset`/`partialBytes` unchanged, no IO at all.
 * • `size < priorOffset + priorPartialBytes.length` ⇒ truncation/shrink ⇒ `truncated:true`, and the read
 *   below proceeds as if `priorOffset`/`priorPartialBytes` were `0`/empty (a fresh read of the whole
 *   current file) — the caller applies its OTHER reset (accumulator/turns/model) around this result.
 * • else: reads ONLY `[lastReadEnd, size)` (looping on a POSIX short `pread` so nothing is silently
 *   dropped nor zero-fill-corrupted), PREPENDS the carried `partialBytes`, splits on the LAST `\n`, and
 *   returns the complete-lines slice (as parsed `string[]`, already split on `\n`) plus the new trailing
 *   partial remainder.
 *
 * UTF-8 safe: `offset` only ever advances to a `\n` boundary (0x0A never appears inside a multibyte UTF-8
 * sequence), and the partial remainder is carried as raw BYTES — a multibyte character split across a
 * chunk boundary is never decoded until its line completes. No dedup set lives here: that's each caller's
 * OWN fold's job (dedupe-and-sum for one, overwrite-last-wins for the other) — this function only ever
 * decides which raw lines exist, never what they mean. {@link IncrementalRunUsageReader}'s cumulative
 * must stay byte-identical to a full {@link readRunUsageFromFile} parse; this extraction must not change
 * that — the RED-proof is a mutant that keeps this function's own API but disables one piece of its
 * logic (e.g. skip the truncation reset), which must turn BOTH readers' tests red.
 *
 * @decision sha:8591caf8 — byte-identical cumulative is load-bearing; any mutant here must redden both
 * readers' tests, proving both route through this one function.
 */
export async function readIncrementalTail(
  file: string,
  size: number,
  priorOffset: number,
  priorPartialBytes: Buffer,
): Promise<IncrementalTailReadResult> {
  let offset = priorOffset;
  let partialBytes = priorPartialBytes;
  let truncated = false;
  let lastReadEnd = offset + partialBytes.length;
  if (size < lastReadEnd) {
    // Truncation/shrink of the same file → the byte offsets are meaningless → re-read from 0.
    truncated = true;
    offset = 0;
    partialBytes = Buffer.alloc(0);
    lastReadEnd = 0;
  }
  if (size === lastReadEnd) return { truncated, offset, partialBytes, lines: [], readFailed: false };

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
  } catch { return { truncated, offset, partialBytes, lines: [], readFailed: true }; }

  // Prepend the buffered partial line, then split on the LAST newline: everything up to it is complete
  // lines; the remainder is the next partial (buffer as bytes). `got` may be < `len` on a truncating
  // read — only the bytes actually read are folded in.
  const combined = Buffer.concat([partialBytes, got === len ? buf : buf.subarray(0, got)]);
  const lastNl = combined.lastIndexOf(0x0A);
  if (lastNl === -1) {
    return { truncated, offset, partialBytes: combined, lines: [], readFailed: false }; // still no complete line
  }
  const complete = combined.subarray(0, lastNl + 1);
  const rest = combined.subarray(lastNl + 1);
  return { truncated, offset: offset + complete.length, partialBytes: rest, lines: complete.toString("utf8").split("\n"), readFailed: false };
}

/**
 * INCREMENTAL + ASYNC cumulative usage reader for the sampler hot path (LAYER 1). Produces, per session, a
 * cumulative RunUsageStats BYTE-IDENTICAL to what a full {@link readRunUsageFromFile} would return — but by
 * parsing only the bytes APPENDED since the last tick, off the event loop (`fs.promises`), instead of
 * re-reading + re-parsing every live session's WHOLE transcript synchronously each tick (the fleet-scale
 * event-loop stall this replaces).
 *
 * @decision sha:8591caf8 — byte-identical to a full parse by construction (same {@link accumulateUsageLine}
 * fold), so the sampler's delta layer (`recordDelta`), including the restart-double-count fix, is
 * preserved unchanged.
 *
 * Per-session cache holds { engineSessionId, offset (at a `\n` boundary), partialBytes, acc (running totals
 * + the dedup `seen` set) }. Each tick, for a session:
 *  • `fs.promises.stat` the transcript; missing/unreadable ⇒ null (skip), cache untouched.
 *  • else delegate the byte-offset/partial-line mechanics to {@link readIncrementalTail} — truncation,
 *    no-new-bytes, and the bounded chunk read/split are all handled there; this class owns only ITS OWN
 *    fold (dedupe-and-sum via {@link accumulateUsageLine}) and cache shape.
 *  • engineSessionId changed vs cache ⇒ fork/recycle rotated to a NEW transcript ⇒ RESET and read the new file.
 *
 * The dedup `seen` set lives in the cache and is cleared ONLY on rotation/reset — so a duplicate message.id
 * line-group straddling a tick's offset boundary is counted exactly ONCE, never re-counted (the load-bearing
 * over-count trap).
 *
 * See {@link IncrementalContextStatsReader} below — its sibling for `MidTurnContextSampler` (card
 * c5b234aa), now sharing this exact byte-offset/partial-line-buffer mechanism via {@link
 * readIncrementalTail} (card 22072f12) rather than duplicating it; each reader keeps its OWN fold
 * semantics (dedupe-and-sum vs last-wins) and OWN file-resolution strategy (bare path only vs a
 * resolve-with-fallback scan) on top of that shared piece.
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

    const result = await readIncrementalTail(file, size, entry.offset, entry.partialBytes);
    if (result.truncated) entry.acc = newUsageAccumulator(); // byte offsets meaningless → fresh accumulator too
    entry.offset = result.offset;
    entry.partialBytes = result.partialBytes;
    for (const line of result.lines) accumulateUsageLine(entry.acc, line);

    return entry.acc.sawUsage ? statsFromAccumulator(entry.acc) : null;
  }

  /** Drop ONE session's cache entry (on session exit — it never ticks again). Mirrors `lastSeen.delete`. */
  drop(sessionId: string): void { this.cache.delete(sessionId); }

  /** Clear ALL cached state (the corrective reset — force a fresh full parse on the next tick). */
  clear(): void { this.cache.clear(); }
}

/** A mid-turn context sample — the SAME occupancy shape {@link readContextStats} returns (last-turn
 *  input+cache tokens, a running turn count, the last-seen model), minus the two text fields that reader
 *  also carries (`lastAssistantText`/`lastUserText`) — the mid-turn sampler never needs them. */
export interface IncrementalContextSample {
  inputTokens: number;
  turns: number;
  model: string | null;
}

/** Per-session incremental parse state for {@link IncrementalContextStatsReader} — mirrors
 *  {@link IncrementalUsageCache} exactly EXCEPT there is no dedup `seen` set: this reader never sums, it
 *  overwrites, so a line straddling a chunk boundary can never be double-counted in the first place. */
interface IncrementalContextCache {
  engineSessionId: string;
  /** The resolved absolute path this entry's `offset`/`partialBytes` are relative to — a cache reset
   *  trigger in its own right (Code Review round 3, card c5b234aa): if a LATER call resolves to a
   *  DIFFERENT path for the same engineSessionId (e.g. `resolveTranscriptFile`'s dir-encoding-drift scan
   *  finds the transcript somewhere new), the old byte offsets describe positions in a different file and
   *  are meaningless against this one — see the `read()` reset below. */
  filePath: string;
  offset: number;
  partialBytes: Buffer;
  turns: number;
  /** Last-seen `inputTokens` (input + cache_read + cache_creation) from an assistant line carrying usage;
   *  null until the first such line is seen — the null-vs-measured discipline `readContextStats` itself
   *  uses (a usage-less assistant line is skipped, never folded in as a bogus zero). */
  lastInputTokens: number | null;
  lastModel: string | null;
}

/**
 * Negative-cache TTL for a transcript that `read()` could not find at all — neither the bare
 * {@link engineTranscriptPath} nor {@link resolveTranscriptFile}'s dir-encoding-drift scan. Without this,
 * a session whose transcript genuinely can't be found re-pays that scan's SYNC `readdirSync` over the
 * whole transcript root (it caches only HITS) on every single sampler tick forever (Code Review round 3,
 * card c5b234aa). A few minutes is long enough to collapse that into an occasional cost instead of a
 * per-tick one, short enough that a transcript created shortly after this miss is found again promptly.
 */
const TRANSCRIPT_MISS_NEGATIVE_CACHE_TTL_MS = 3 * 60_000;

/**
 * Fold ONE transcript JSONL line into `state`, LAST-WINS (never summed) — mirrors `readContextStats`'s own
 * loop body exactly (same skip conditions, same order: turns++ before the usage check, so a usage-less
 * assistant line still advances `turns`), so this incremental fold is byte-identical in its RESULT to
 * running that full-file loop over the same lines. No dedup is needed (unlike {@link accumulateUsageLine}):
 * each new line is itself the new "last," so a split-message duplicate line simply overwrites with the
 * same value, never an over-count.
 *
 * Returns true iff THIS line actually carried a usage-bearing assistant message (i.e. it set
 * `state.lastInputTokens`) — false for a blank line, bad JSON, a non-assistant line (user/tool_result),
 * a synthetic API-error line, or an assistant line with no `usage` field. The caller needs this to tell
 * "a complete new line arrived, but it wasn't a fresh usage reading" apart from "a fresh usage reading
 * arrived" — `state.lastInputTokens == null` alone can't do that once a PRIOR call has already set it,
 * since it then stays non-null forever regardless of what the current call's own lines were.
 */
function foldContextLine(state: { turns: number; lastInputTokens: number | null; lastModel: string | null }, line: string): boolean {
  if (!line.trim()) return false;
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return false; }
  if (o.type !== "assistant" || !o.message) return false;
  if (o.isApiErrorMessage === true) return false; // synthetic API-error line — see readContextStats's own doc
  state.turns++;
  const msg = o.message as { usage?: Record<string, unknown>; model?: string };
  if (typeof msg.model === "string") state.lastModel = msg.model;
  if (!msg.usage) return false;
  state.lastInputTokens =
    num(msg.usage.input_tokens) + num(msg.usage.cache_read_input_tokens) + num(msg.usage.cache_creation_input_tokens);
  return true;
}

/**
 * INCREMENTAL + ASYNC mid-turn context-occupancy reader — the sibling of
 * {@link IncrementalRunUsageReader} above, built for `MidTurnContextSampler` instead of `UsageSampler`.
 * Both now delegate the byte-offset/partial-line mechanics to the SAME {@link readIncrementalTail} (card
 * 22072f12) rather than duplicating it, while staying separate classes: each keeps its OWN fold — this
 * one tracks "last-wins" occupancy via {@link foldContextLine} instead of a deduped cumulative sum, so it
 * carries no `seen` set — plus its OWN cache shape, reset-on-rotation (card 8a5bd0d0), and file
 * resolution. PATH RESOLUTION is the real remaining difference from the sibling: it falls back to
 * {@link resolveTranscriptFile}'s dir-encoding-drift scan, caching the winning path per session ({@link
 * resolvedPathCache} below) when the bare {@link engineTranscriptPath} misses; the sibling deliberately
 * does NOT — an accepted gap for cost-tracking but not for exhaustion-prevention, where a session that
 * silently never samples is exactly the failure this class exists to close.
 */
export class IncrementalContextStatsReader {
  private cache = new Map<string, IncrementalContextCache>();
  /**
   * Card c5b234aa, Code Review round 2: the ONE-TIME-resolved absolute path for a session whose bare
   * {@link engineTranscriptPath} missed and {@link resolveTranscriptFile}'s scan-fallback (card f10a6f40
   * dir-encoding drift) found it elsewhere — avoids re-paying that scan (a real `readdirSync` of the
   * whole transcript root) on every tick forever.
   *
   * Card 85b66b46 (round-4 follow-up, item 1): also carries the `engineSessionId` the path was resolved
   * under, same shape as {@link missCache} below — keying by sessionId alone let a stale path from an
   * ABANDONED engine id survive a rotation: the rotation-clear in `read()` only fires when a `cache`
   * entry already exists, but a resolved path can land here with NO `cache` entry yet (the stat right
   * after `resolvedPathCache.set` can itself throw — see `read()`'s own comment at that site). `read()`
   * below treats a path resolved under a different `engineSessionId` as no cache hit at all.
   */
  private resolvedPathCache = new Map<string, { engineSessionId: string; path: string }>();
  /**
   * Negative cache for a session whose transcript could not be found at all (neither the bare path nor
   * `resolveTranscriptFile`'s scan) — see {@link TRANSCRIPT_MISS_NEGATIVE_CACHE_TTL_MS}'s own doc for
   * why this exists. Keyed by sessionId; `missedAt` is `Date.now()` at the miss. Cleared alongside
   * `cache`/`resolvedPathCache` on rotation/drop/clear.
   *
   * Card c5b234aa (Code Review round 4): also carries the `engineSessionId` the miss was recorded
   * under. A session whose transcript is NEVER found keeps no `cache` entry at all (that only gets
   * created once a file is actually located), so the rotation-clear below — which keys off an existing
   * `cache` entry's `engineSessionId` — can never fire for such a session; without this field, a stale
   * miss recorded under an ABANDONED engine session id would wrongly suppress a fresh scan for the NEW
   * one for the rest of the TTL window. `read()` below treats a miss recorded under a different
   * `engineSessionId` as no cache hit at all.
   */
  private missCache = new Map<string, { engineSessionId: string; missedAt: number }>();

  /**
   * Return `sessionId`'s mid-turn occupancy IF (and only if) this call actually folded in a new, complete
   * usage-bearing assistant line — null otherwise, on EVERY "nothing new" path (no new bytes at all, a
   * new chunk that's still a buffered partial line, an IO error, or a complete new line with no `usage`
   * field). This is a deliberate difference from {@link IncrementalRunUsageReader}, whose `read` always
   * returns the latest-known cumulative even on a no-op tick: a cumulative is meaningful to re-report
   * unchanged, but re-writing an UNCHANGED mid-turn reading into the DB on every tick would churn
   * `ctx_updated_at` for no reason and defeat its own purpose (telling a reader "was this reading taken
   * just now") — so the caller (`MidTurnContextSampler`) writes ONLY when this returns non-null.
   */
  async read(sessionId: string, cwd: string, engineSessionId: string): Promise<IncrementalContextSample | null> {
    let entry = this.cache.get(sessionId);
    if (entry && entry.engineSessionId !== engineSessionId) {
      this.cache.delete(sessionId);
      this.resolvedPathCache.delete(sessionId); // a resolved path from the ABANDONED engine id is stale too
      this.missCache.delete(sessionId); // a stale miss from the ABANDONED engine id must not suppress a fresh scan
      entry = undefined;
    }

    const bareFile = engineTranscriptPath(cwd, engineSessionId);
    // Card 85b66b46 (item 1): a resolved path recorded under a DIFFERENT engineSessionId is no cache hit
    // at all — same discipline as the missCache check below, and for the same reason: this map can carry
    // a resolved path for a session with NO `cache` entry (see resolvedPathCache's own doc), so the
    // rotation-clear above can't be relied on to have cleared a stale entry here either.
    const resolvedCached = this.resolvedPathCache.get(sessionId);
    let file = resolvedCached && resolvedCached.engineSessionId === engineSessionId ? resolvedCached.path : bareFile;
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      // Bare path (or a previously-resolved path) missed. A recent miss for THIS engine id suppresses the
      // scan fallback below (see TRANSCRIPT_MISS_NEGATIVE_CACHE_TTL_MS's own doc) — the cheap bare stat
      // above still runs every tick, so a transcript that appears mid-window is still found on its own.
      // Card c5b234aa (round 4): a miss recorded under a DIFFERENT engineSessionId is no cache hit at all
      // — see missCache's own doc for why the rotation-clear above can't be relied on for this case.
      const miss = this.missCache.get(sessionId);
      if (miss && miss.engineSessionId === engineSessionId && Date.now() - miss.missedAt < TRANSCRIPT_MISS_NEGATIVE_CACHE_TTL_MS) return null;
      // Fall back to resolveTranscriptFile's own dir-encoding-drift scan ONCE — it has its own internal
      // engineSessionId-keyed cache (see that function's own doc), so repeating this call across ticks
      // would already skip the real readdir after the first hit; caching the WINNING PATH here too
      // additionally skips resolveTranscriptFile's own existsSync-plus-cache-lookup overhead on every
      // later tick, going straight to a bare stat.
      const resolved = resolveTranscriptFile(cwd, engineSessionId);
      if (!resolved) {
        this.missCache.set(sessionId, { engineSessionId, missedAt: Date.now() });
        return null; // genuinely missing/unreadable — nothing to report
      }
      this.missCache.delete(sessionId);
      this.resolvedPathCache.set(sessionId, { engineSessionId, path: resolved });
      file = resolved;
      try { size = (await fs.promises.stat(file)).size; }
      catch { return null; }
    }

    if (!entry || entry.filePath !== file) {
      // No cache yet, OR the resolved path changed to a DIFFERENT file since the last read (e.g.
      // resolveTranscriptFile's drift scan found the transcript somewhere new) — entry.offset/partialBytes
      // would describe byte positions in that OTHER file and are meaningless against this one; reset +
      // full re-read from 0.
      entry = { engineSessionId, filePath: file, offset: 0, partialBytes: Buffer.alloc(0), turns: 0, lastInputTokens: null, lastModel: null };
      this.cache.set(sessionId, entry);
    }

    const result = await readIncrementalTail(file, size, entry.offset, entry.partialBytes);
    if (result.truncated) { entry.turns = 0; entry.lastInputTokens = null; entry.lastModel = null; }
    entry.offset = result.offset;
    entry.partialBytes = result.partialBytes;
    if (result.lines.length === 0) return null; // no new bytes, still-partial, or the read itself failed

    // Card c5b234aa, Code Review round 2: track whether THIS call's own batch of new lines folded in a
    // fresh usage reading — `entry.lastInputTokens == null` alone cannot tell that apart from "a PRIOR
    // call already set it and this batch was a user line / tool_result / API-error line that changed
    // nothing," which would silently re-report an old reading as fresh (a false ctxMidTurn:true, and
    // churn on every such line with no new usage to report).
    let foldedUsage = false;
    for (const line of result.lines) {
      if (foldContextLine(entry, line)) foldedUsage = true;
    }
    if (!foldedUsage) return null; // this batch had nothing usage-bearing — nothing new to report
    return { inputTokens: entry.lastInputTokens!, turns: entry.turns, model: entry.lastModel };
  }

  /** Drop ONE session's cache entry (on session exit — it never ticks again). */
  drop(sessionId: string): void {
    this.cache.delete(sessionId);
    this.resolvedPathCache.delete(sessionId);
    this.missCache.delete(sessionId);
  }

  /** Clear ALL cached state (force a fresh full parse on the next tick). */
  clear(): void { this.cache.clear(); this.resolvedPathCache.clear(); this.missCache.clear(); }
}
