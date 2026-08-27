import fs from "node:fs";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";
import { spillTextIfLarge, SPILL_INLINE_BUDGET_CHARS } from "../spill.js";
import {
  type TranscriptTurn,
  encodeProjectDir,
  engineTranscriptPath,
  resolveTranscriptFile,
  engineTranscriptExists,
  readTranscript,
  parseTranscriptFile,
  TOOL_RESULT_BODY_CAP,
} from "../pty/claude-transcript.js";

/**
 * HarnessAdapter seam (card 2b099e48): this file is the harness-AGNOSTIC half of transcript handling —
 * pagination, spill-to-scratch-file, and Loom's OWN archive store (`LOOM_HOME/archives`), all of which
 * operate on the generic {@link TranscriptTurn} shape and Loom's own on-disk layout, never a claude-format
 * literal. The claude-JSONL-specific half (path resolution, wire-format parsing) now lives in
 * `pty/claude-transcript.ts` — re-exported below UNCHANGED so every existing consumer of this module
 * (13 files, none of which need to change) keeps importing the same names from the same place.
 */
export type { TranscriptTurn };
export { encodeProjectDir, engineTranscriptPath, resolveTranscriptFile, engineTranscriptExists, readTranscript, TOOL_RESULT_BODY_CAP };

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Transcript PAGINATION — bound a single transcript_read to the tool-result token cap.
//
// A whole large transcript serialized in one shot overflows the MCP tool-result cap, spills to a temp
// file with one giant unpaginatable line, and forces a manual char-slice to read it. So instead we hand
// back ONE bounded page at a time, carrying enough metadata (totalTurns + nextOffset) that a caller can
// page deterministically start → nextOffset → … → null with NO gaps or overlaps and FULL coverage.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Per-PAGE size budget (chars) for a transcript_read page. A single rendered page must fit the MCP
 * tool-result token cap, with headroom for the page envelope and JSON quoting. An ALIAS of
 * {@link SPILL_INLINE_BUDGET_CHARS} (spill.ts) — same underlying "MCP tool-result inline cap" figure,
 * kept as its own exported name here since call sites in this module already read as "the transcript
 * page budget." A page is bounded by this budget so it can never overflow / spill.
 */
export const TRANSCRIPT_PAGE_CHAR_BUDGET = SPILL_INLINE_BUDGET_CHARS;

/** Hard ceiling on turns per page (independent of the char budget) — a defensive upper bound. */
export const DEFAULT_TRANSCRIPT_PAGE_TURNS = 400;

export interface TranscriptPage {
  turns: TranscriptTurn[];
  /** Total turns in the whole (un-paged) transcript — lets a caller know how much is left. */
  totalTurns: number;
  /** Start turn index of THIS page. */
  offset: number;
  /** Turns returned in THIS page. */
  returned: number;
  /** Offset to pass for the NEXT page, or null when this page reached the end of the (ranged) transcript. */
  nextOffset: number | null;
  /**
   * True when `nextOffset` was forced to null by {@link applyAggregateWalkCap} even though more turns
   * remained — the caller has walked far enough via offset->nextOffset chaining that continuing would
   * re-ingest an unbounded amount of the transcript. Switch to a targeted `turnRange` read instead.
   * Absent (not just false) on a page the cap never touched.
   */
  truncated?: boolean;
}

/**
 * Slice a rendered transcript into ONE bounded page. Pure + deterministic. A page starts at `offset`
 * (or `turnRange[0]`) and includes as many consecutive turns as fit under BOTH `limit` (turn count) and
 * {@link TRANSCRIPT_PAGE_CHAR_BUDGET} (serialized size) — but ALWAYS at least one turn, so a single
 * oversized turn can't stall paging. `turnRange` (`[startInclusive, endExclusive]`) bounds the
 * addressable window; pages within it are still budget-bounded. `nextOffset` is `offset + returned`
 * while more remains in the window, else null — so paging start → nextOffset → … → null covers the
 * whole window exactly once (no gaps, no overlaps).
 */
export function pageTranscript(
  all: TranscriptTurn[],
  opts: { offset?: number; limit?: number; turnRange?: [number, number] } = {},
): TranscriptPage {
  const total = all.length;
  const rawStart = opts.turnRange ? opts.turnRange[0] : (opts.offset ?? 0);
  const start = Math.max(0, Math.min(rawStart, total));
  // Exclusive end of the addressable window: turnRange[1] (clamped) or the whole transcript.
  const windowEnd = opts.turnRange ? Math.max(start, Math.min(opts.turnRange[1], total)) : total;
  const maxTurns = opts.limit !== undefined ? Math.max(1, opts.limit) : DEFAULT_TRANSCRIPT_PAGE_TURNS;
  const turns: TranscriptTurn[] = [];
  let chars = 0;
  for (let i = start; i < windowEnd && turns.length < maxTurns; i++) {
    const t = all[i];
    if (!t) break;
    // Approximate the turn's serialized footprint (text + role + JSON key/quote/brace overhead).
    const size = t.text.length + t.role.length + 40;
    if (turns.length > 0 && chars + size > TRANSCRIPT_PAGE_CHAR_BUDGET) break; // always take ≥1 turn
    turns.push(t);
    chars += size;
  }
  const endIdx = start + turns.length;
  return { turns, totalTurns: total, offset: start, returned: turns.length, nextOffset: endIdx < windowEnd ? endIdx : null };
}

/** Approximate a turn's serialized footprint the same way {@link pageTranscript} does. */
function turnCharSize(t: TranscriptTurn): number {
  return t.text.length + t.role.length + 40;
}

/**
 * Bounded "last N turns" read: like `all.slice(-n)`, but capped to {@link TRANSCRIPT_PAGE_CHAR_BUDGET}
 * so a large `n` (or large turns) can't bypass the page budget the way a bare slice used to — this was
 * the one read path in the module that skipped the budget entirely. Always keeps at least the single
 * most recent turn, and always keeps the MOST RECENT turns (trims from the OLDER end of the requested
 * window when the budget is exceeded), mirroring pageTranscript's own "always take >=1" rule.
 */
export function lastNTurns(all: TranscriptTurn[], n: number): TranscriptTurn[] {
  const want = Math.max(1, n);
  const start = Math.max(0, all.length - want);
  let chars = 0;
  let firstIncluded = all.length;
  for (let i = all.length - 1; i >= start; i--) {
    const t = all[i];
    if (!t) break;
    const size = turnCharSize(t);
    if (firstIncluded < all.length && chars + size > TRANSCRIPT_PAGE_CHAR_BUDGET) break; // always take >=1
    chars += size;
    firstIncluded = i;
  }
  return all.slice(firstIncluded);
}

/**
 * Aggregate ceiling (chars) on ONE caller's sequential offset -> nextOffset walk through a transcript.
 * A single page is already bounded by {@link TRANSCRIPT_PAGE_CHAR_BUDGET}, but nothing stopped a caller
 * from looping start -> nextOffset arbitrarily many times and re-ingesting an entire (possibly
 * multi-megabyte) transcript page by page. 10 pages (~480KB, ~120K tokens) is generous headroom for a
 * real investigation; walking further should be a deliberate turnRange-targeted read, not a blind loop.
 */
export const TRANSCRIPT_AGGREGATE_CHAR_BUDGET = TRANSCRIPT_PAGE_CHAR_BUDGET * 10;

/**
 * Per-process tracker of chars consumed by a caller's IN-PROGRESS sequential offset-walk of one
 * transcript, keyed by an identity for "this transcript" (e.g. its engineSessionId). A single
 * pageTranscript() call can't tell a chained offset:nextOffset continuation apart from a fresh direct
 * jump to some offset — both arrive as the same bare {offset} — so the walk is tracked explicitly here
 * instead, mirroring the daemon's other per-session in-memory trackers (e.g. the companion's trust
 * windows). Bounded to a small number of concurrently in-progress walks (evicted oldest-first) so this
 * can never grow unbounded over a long daemon lifetime.
 */
const MAX_TRACKED_WALKS = 200;
const walkState = new Map<string, { consumed: number; expectedOffset: number }>();

/**
 * Apply the aggregate walk cap to a page {@link pageTranscript} just produced, keyed by `walkKey`. A
 * call that CONTINUES the walk this key is already tracking (its `requestedOffset` matches the
 * previous page's `nextOffset`) accumulates onto that walk's running total; anything else — a fresh
 * read, a direct jump, a different turnRange — starts a new walk at 0 and is never penalized by an
 * unrelated prior walk. Once the walk's cumulative served chars reach
 * {@link TRANSCRIPT_AGGREGATE_CHAR_BUDGET}, the page is returned with `nextOffset` forced to null and
 * `truncated:true` — even though pageTranscript itself had more to give — so a caller can't keep
 * looping past the cap; it must switch to a targeted turnRange read instead. A page whose `nextOffset`
 * was ALREADY null (the walk finished naturally, within budget) passes through untouched.
 */
export function applyAggregateWalkCap(walkKey: string, requestedOffset: number, page: TranscriptPage): TranscriptPage {
  if (page.nextOffset === null) {
    walkState.delete(walkKey);
    return page;
  }
  const prior = walkState.get(walkKey);
  const continuing = prior !== undefined && prior.expectedOffset === requestedOffset;
  const consumed = (continuing ? prior.consumed : 0) + page.turns.reduce((sum, t) => sum + turnCharSize(t), 0);
  if (consumed >= TRANSCRIPT_AGGREGATE_CHAR_BUDGET) {
    walkState.delete(walkKey);
    return { ...page, nextOffset: null, truncated: true };
  }
  if (!walkState.has(walkKey) && walkState.size >= MAX_TRACKED_WALKS) {
    const oldest = walkState.keys().next().value;
    if (oldest !== undefined) walkState.delete(oldest);
  }
  walkState.set(walkKey, { consumed, expectedOffset: page.nextOffset });
  return page;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Turns-response SPILL — a page/lastN/bare-array result can still overflow the tool-result cap even
// though `pageTranscript` bounds page SIZE, because it always includes >=1 turn regardless of that
// turn's own size (a single message can legitimately carry many/large tool_result blocks — e.g. a
// batch of browser_snapshot calls). Card 605988ab: `worker_transcript`/`transcript_read` previously
// handed such a page straight to `JSON.stringify`, which escapes every real newline INSIDE a turn's
// own text (a tool_result body is already rendered, human-readable, often multi-line — e.g.
// browser_snapshot's YAML) into a literal two-char `\n`, collapsing the whole response into one
// unpageable line once the host engine's own overflow-spill kicks in. `spillableTurnsResponse` below
// generalizes the proactive-own-spill pattern `SessionService.spillMergePatch` established for
// worker_merge's fullDiff to this surface.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Render turns as plain, human-readable text — NOT `JSON.stringify`, which would re-escape a tool
 * result's own real line breaks into a literal `\n`. Each turn gets a one-line marker header (so a
 * spilled file stays attributable and grep-able turn-by-turn) followed by its text VERBATIM, real
 * newlines intact — "unwrapping" a YAML-shaped tool_result (e.g. browser_snapshot) for free, since
 * `TranscriptTurn.text` is already the rendered, unescaped string by the time it reaches here.
 */
function renderTurnsAsText(turns: TranscriptTurn[]): string {
  return turns.map((t, i) => `=== turn ${i} [${t.role}] ===\n${t.text}`).join("\n\n");
}

/**
 * Format a turns-bearing MCP response for `sessionId` (the RECIPIENT — the manager/auditor that will
 * read this result, not the transcript's own owner), spilling to that session's scratch dir when the
 * rendered turns would overflow {@link TRANSCRIPT_PAGE_CHAR_BUDGET} — the SAME budget `pageTranscript`/
 * `lastNTurns` already bound a page to, so a normal multi-turn page they've already kept within budget
 * never spills; only the genuine ">=1 turn forced past budget" edge case (a single oversized turn, or a
 * `lastN` selection dominated by one) does. `key` should be deterministic per (target transcript, page)
 * so repeated pulls overwrite rather than accumulate.
 *
 * BELOW the cap: byte-identical to before — `envelope` (if any) with the real `turns` array attached,
 * or the bare `turns` array itself when `envelope` is null.
 * ABOVE the cap: `turns` is replaced by `{turnsFile, turnsChars, note}` pointing at a plain-text scratch
 * file (real per-turn line breaks, explicit UTF-8) instead — grep/Read-pageable, unlike the JSON string
 * it replaces. Any envelope metadata (totalTurns/offset/returned/nextOffset/…) stays inline either way.
 */
export function spillableTurnsResponse(
  sessionId: string, key: string, turns: TranscriptTurn[], envelope: Record<string, unknown> | null,
): unknown {
  const spill = spillTextIfLarge(sessionId, "transcript-spills", key, renderTurnsAsText(turns), TRANSCRIPT_PAGE_CHAR_BUDGET);
  if (spill.inline) return envelope ? { ...envelope, turns } : turns;
  const note =
    `Turns are ${spill.chars} chars — too large to inline safely, so they were written to ${spill.file} as ` +
    "plain text (one turn per \"=== turn N [role] ===\" section, real line breaks, UTF-8) — a tool result's " +
    "own multi-line content (e.g. a browser_snapshot's YAML) survives verbatim. Page it with Read (offset/limit " +
    "are LINE-based) or grep it for a keyword / turn marker. Re-call with a narrower turnRange/limit/lastN to " +
    "inline fewer turns instead.";
  const pointer = { turnsFile: spill.file, turnsChars: spill.chars, note };
  return envelope ? { ...envelope, ...pointer } : pointer;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Session Archive — transcript SNAPSHOT.
//
// Loom does NOT own transcripts; a session goes `resumability:"dead"` precisely BECAUSE Claude's
// JSONL was deleted. So preserve (at EXIT, while the JSONL still exists) and archive (a later UI
// tidy) are separate. snapshotTranscript copies the live JSONL into LOOM_HOME so an archived
// session keeps a readable transcript even after Claude prunes the original. The snapshot is keyed
// by (projectId, sessionId) — NOT the engine id — so it survives even if the engine id is reused.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Absolute path to a session's archived transcript snapshot under LOOM_HOME, CONFINED to the archive
 * store. SECURITY: `projectId`/`sessionId` are CALLER-CONTROLLED on the auditor read path
 * (transcript_read archived, registered on BOTH the auditor + workspace-auditor routers), so a hostile id
 * must NOT escape `<LOOM_HOME>/archives` and read an arbitrary host `*.jsonl` (Claude's own session
 * transcripts, secrets). Confining HERE — at the single source every caller funnels through — protects
 * EVERY caller (read + write) and BOTH router surfaces, not just one tool. Mirrors repo-read's
 * `resolveWithin` gate and rejects all THREE escape classes: a `..` TRAVERSAL (`path.resolve` would walk
 * out of the root), an ABSOLUTE id (`path.resolve` discards the root), and a SYMLINK inside the store that
 * points OUT (realpath re-check). A legitimate id resolves byte-identically. */
export function archivedTranscriptPath(projectId: string, sessionId: string): string {
  // Realpath the archives root so a symlinked LOOM_HOME (e.g. macOS /tmp -> /private/tmp) still compares
  // correctly; fall back to the lexical resolve when the dir doesn't exist yet (no snapshot captured).
  const rawRoot = path.resolve(LOOM_HOME, "archives");
  let root: string;
  try { root = fs.realpathSync(rawRoot); } catch { root = rawRoot; }
  const within = (p: string) => p === root || p.startsWith(root + path.sep);
  const abs = path.resolve(root, projectId, `${sessionId}.jsonl`);
  if (!within(abs)) throw new Error("archived transcript path escapes the archives root");
  // Defeat a symlink inside the store that resolves OUTSIDE it: realpath the (existing) target and
  // re-check. ENOENT just means no snapshot yet — the lexical check above already confines it.
  try {
    const real = fs.realpathSync(abs);
    if (!within(real)) throw new Error("archived transcript path escapes the archives root (symlink)");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
  return abs;
}

/** Whether a transcript snapshot was captured for this session. False on a confinement escape (never throws). */
export function archivedTranscriptExists(projectId: string, sessionId: string): boolean {
  try { return fs.existsSync(archivedTranscriptPath(projectId, sessionId)); }
  catch { return false; }
}

/**
 * Whether a session's transcript is readable AT ALL — either the on-exit snapshot was captured, or
 * (when it wasn't) the raw engine JSONL is still on disk. Distinct from `archivedTranscriptExists`:
 * `snapshotTranscript` is best-effort and can silently fail (a disk error, a race) while the raw file
 * survives — that failure alone must not be read as "no transcript" (card 0138c09b). A caller deciding
 * whether to OFFER a transcript view (as opposed to reading its content) should use this, not
 * `archivedTranscriptExists` alone, or a failed-but-recoverable snapshot renders as "nothing to show".
 */
export function transcriptAvailable(s: { projectId: string; id: string; cwd: string; engineSessionId: string | null }): boolean {
  if (archivedTranscriptExists(s.projectId, s.id)) return true;
  return s.engineSessionId != null && engineTranscriptExists(s.cwd, s.engineSessionId);
}

/**
 * Session ids (within one project's archive dir) that have a captured snapshot — ONE `readdir` instead
 * of a per-row `fs.existsSync` stat. Built for bulk-enriching an archived-sessions list page: a caller
 * enriching N rows across P distinct projects does P readdirs total, not N stats (the archived-sessions
 * gateway routes were measured doing N synchronous stats per request, 2137 rows ⇒ 500ms+ of blocked
 * event loop — see project-memory `perf-profile-2026-07-16-findings`). Empty set if the project has no
 * archive dir yet or `projectId` fails the same confinement check `archivedTranscriptPath` applies
 * (never throws). Mirrors that function's root — keep the two in sync if the archive layout changes.
 */
export function archivedSnapshotIds(projectId: string): Set<string> {
  const rawRoot = path.resolve(LOOM_HOME, "archives");
  let root: string;
  try { root = fs.realpathSync(rawRoot); } catch { root = rawRoot; }
  const dir = path.resolve(root, projectId);
  const ids = new Set<string>();
  if (dir !== root && !dir.startsWith(root + path.sep)) return ids; // confinement escape — same as archivedTranscriptPath
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return ids; }
  for (const name of entries) {
    if (name.endsWith(".jsonl")) ids.add(name.slice(0, -".jsonl".length));
  }
  return ids;
}

/**
 * Best-effort snapshot of a session's engine transcript into the archive store. Called on the
 * onExit transition (while the JSONL still exists). NEVER throws — the exit path must not be
 * blocked. Idempotent: re-copies only when the snapshot is missing or older than the source (so a
 * resumed-then-exited session refreshes its snapshot). Returns true iff a snapshot now exists.
 * An already-dead session (no source JSONL) → no snapshot (returns false; the archive row then
 * shows metadata only). Copy is atomic (temp + rename) so a concurrent read never sees a partial.
 */
export function snapshotTranscript(
  cwd: string, engineSessionId: string, projectId: string, sessionId: string,
): boolean {
  try {
    const src = resolveTranscriptFile(cwd, engineSessionId);
    if (!src) return false; // already-dead session — nothing to preserve
    const dest = archivedTranscriptPath(projectId, sessionId);
    try {
      const d = fs.statSync(dest);
      const s = fs.statSync(src);
      if (d.mtimeMs >= s.mtimeMs) return true; // snapshot already current — idempotent no-op
    } catch { /* no snapshot yet — fall through and create it */ }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest); // atomic publish
    return true;
  } catch {
    return false; // BEST-EFFORT — a snapshot failure must never disturb the exit path
  }
}

/** Render an archived snapshot with the SAME parser as readTranscript. [] when no snapshot exists. */
export function readArchivedTranscript(projectId: string, sessionId: string): TranscriptTurn[] {
  const file = archivedTranscriptPath(projectId, sessionId);
  if (!fs.existsSync(file)) return [];
  return parseTranscriptFile(file);
}

/** Best-effort removal of a session's transcript snapshot (on permanent delete). Never throws. */
export function deleteArchivedTranscript(projectId: string, sessionId: string): void {
  try { fs.rmSync(archivedTranscriptPath(projectId, sessionId), { force: true }); } catch { /* best-effort */ }
}

/**
 * Best-effort removal of ALL transcript snapshots for a project (on PERMANENT project delete) — drops
 * the whole `LOOM_HOME/archives/<projectId>` dir in one shot, so no orphan snapshot survives the
 * cascade. Never throws (mirrors deleteArchivedTranscript). A project with no snapshots dir is a no-op.
 */
export function deleteProjectArchives(projectId: string): void {
  try { fs.rmSync(path.join(LOOM_HOME, "archives", projectId), { recursive: true, force: true }); } catch { /* best-effort */ }
}
