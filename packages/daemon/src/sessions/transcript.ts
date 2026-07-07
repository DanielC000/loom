import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOOM_HOME } from "../paths.js";

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

/**
 * Per-tool-result body cap (chars) retained in a rendered turn. Tool results were previously collapsed
 * to a bare "-> tool result" placeholder, so an auditor reading a transcript could only see the agent's
 * paraphrase — never the actual error string / structured return (delivered flags, error codes, exit
 * statuses) needed to VERIFY a claim. We now keep the body, truncated to this cap: 2 KB comfortably fits
 * the small structured returns that matter for verification while bounding a giant file-read/log dump.
 */
export const TOOL_RESULT_BODY_CAP = 2048;

/**
 * Repair a CONFIRMED engine-side transcript-capture quirk (Claude Code CLI on Windows, v2.1.202): the
 * last line of a Grep/Read `-C` context hunk occasionally has its leading comment token collapsed to a
 * bare backslash where the ENGINE WRITES ITS OWN on-disk JSONL — `// Guard the X` -> `\ Guard the X`,
 * `/** Every Y` -> `\** Every Y` (verified against a real transcript; the source file itself is
 * untouched — `git show`/`Read` on the same line reads back clean `//`/`/**`). Loom's daemon never
 * touches this text before this point (it's a straight `fs.readFileSync` + `JSON.parse` of the engine's
 * file), so this can't be fixed at the source — but the loom-audit surface must still hand an auditor
 * VERBATIM code, so repair the known corruption here at read time instead of passing it through.
 *
 * Per LINE (Grep/Read output is always line-oriented — `NNNN-`/`NNNN:`/`NNNN\t` decoration then the
 * source indentation): strip that leading decoration, and if what remains starts with a bare `\`
 * followed by a space or `*`, restore the dropped slash(es). A source/comment line never legitimately
 * starts (after its own indentation) with `\ ` or `\*` — that exact pair only arises from this engine
 * collapse — so the repair can't false-positive on real content; a mid-line backslash (e.g. a quoted
 * Windows path) is untouched since it never sits at this leading position.
 */
const LINE_DECORATION_RE = /^[ \t]*(?:\d+[:\t-])?[ \t]*/;
function repairMangledCommentMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const prefixLen = LINE_DECORATION_RE.exec(line)![0].length;
      const rest = line.slice(prefixLen);
      if (rest.startsWith("\\ ")) return line.slice(0, prefixLen) + "//" + rest.slice(1);
      if (rest.startsWith("\\*")) return line.slice(0, prefixLen) + "/" + rest.slice(1);
      return line;
    })
    .join("\n");
}

/** Pull the human-readable body out of a tool_result content block (string or array-of-blocks form). */
function toolResultBody(c: Record<string, unknown>): string {
  const content = c.content;
  if (typeof content === "string") return repairMangledCommentMarkers(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object") {
        const b = p as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return repairMangledCommentMarkers(parts.join("\n"));
  }
  return "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  // The turn markers are kept ASCII ("[tool]" / "-> tool result") ON PURPOSE: a rendered transcript is
  // read on Windows too, where a downstream char-slice / print of the text crashes if it carries non-ASCII
  // glyphs that don't round-trip cp1252 (the old "⚙"/"↳" markers did exactly that). Keeping OUR injected
  // markup ASCII removes that hazard from the part of the transcript Loom controls.
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "tool_use") parts.push(`[tool] ${String(c.name ?? "")}(${JSON.stringify(c.input ?? {}).slice(0, 200)})`);
    else if (c.type === "tool_result") {
      // Retain the body (truncated) instead of collapsing to a bare placeholder, so an auditor can
      // verify error strings / structured returns rather than read only the agent's paraphrase.
      const errFlag = c.is_error === true ? " (error)" : "";
      const body = toolResultBody(c).trim();
      if (!body) { parts.push(`-> tool result${errFlag}`); continue; }
      const shown = body.length > TOOL_RESULT_BODY_CAP
        ? `${body.slice(0, TOOL_RESULT_BODY_CAP)}... [+${body.length - TOOL_RESULT_BODY_CAP} chars truncated]`
        : body;
      parts.push(`-> tool result${errFlag}: ${shown}`);
    }
  }
  return parts.join("\n");
}

/** Parse one transcript JSONL file at `file` into clean, ordered turns (shared by live + archived). */
function parseTranscriptFile(file: string): TranscriptTurn[] {
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

/**
 * Render Claude's session JSONL into a clean, ordered transcript — the canonical
 * "read past conversation" surface (terminal scrollback is best-effort live-only).
 */
export function readTranscript(cwd: string, engineSessionId: string): TranscriptTurn[] {
  const file = resolveTranscriptFile(cwd, engineSessionId);
  if (!file) return [];
  return parseTranscriptFile(file);
}

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
 * tool-result token cap; ~48 KB is roughly 12K tokens — comfortably under the cap with headroom for the
 * page envelope and JSON quoting. A page is bounded by this budget so it can never overflow / spill.
 */
export const TRANSCRIPT_PAGE_CHAR_BUDGET = 48_000;

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
