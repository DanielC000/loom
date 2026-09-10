import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptTurn } from "./adapter.js";

/**
 * @decision 2b099e48 — this file OWNS every `~/.claude/projects/...` literal path and Claude Code
 * transcript wire-format assumption; never duplicate them in `sessions/transcript.ts` or elsewhere.
 * `TranscriptTurn` itself lives in `pty/adapter.ts` (the harness-agnostic contract), re-exported here.
 */
export type { TranscriptTurn };

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
 * Card ac90ca8e — the CLI's own gitignore-style `permissions.deny` rule (`Read(<glob>)`, `~/` expands
 * to the engine's homedir) that covers the WHOLE transcript root every engine session's `.jsonl` lives
 * under — i.e. every project dir this file's own `encodeProjectDir` can produce, not one session's
 * single file. `pty/host.ts`'s `withTranscriptRootDenyForSpawn` (the single `createPty` spawn
 * chokepoint, since card 3388be4d) unions this into a spawn's `permission.deny` for `assistant`,
 * `auditor` and `workspace-auditor` roles (card 44fa586a), closing the native Read/Glob bypass of
 * `transcript_read`'s owner-turn + DM-scope + project-scope gate (that tool reads exactly this root —
 * see engineTranscriptPath above — so a companion refused there could otherwise read the identical
 * bytes off disk with no such checks). Lives HERE (the adapter module), not at the host.ts call site,
 * per this file's own header: every `~/.claude/projects/...` literal is owned by the harness adapter alone.
 */
export const TRANSCRIPT_ROOT_READ_DENY_RULE = "Read(~/.claude/projects/**)";

/**
 * @decision d78f8217 — worker-role per-other-project transcript deny (31613c1e's approved option (d)):
 * a DENY-LIST over a DB-derived set, so it FAILS OPEN on anything unenumerated — best-effort, NEVER a
 * structural guarantee. Carry that limit verbatim wherever cited (31613c1e's LEAD RULING).
 */
export function otherProjectTranscriptDenyRules(otherProjectId: string, otherProjectRepoPath: string): string[] {
  return [
    `Read(~/.claude/projects/*-${otherProjectId}-*/**)`,
    `Read(~/.claude/projects/${encodeProjectDir(otherProjectRepoPath)}/**)`,
  ];
}

/**
 * Locate a session's transcript file robustly: the computed path first (fast, correct for the
 * common case), else scan `~/.claude/projects/*` for `<engineSessionId>.jsonl` — the id is a
 * globally-unique UUID, so a match is unambiguous regardless of how Claude encoded the dir. Returns
 * null if not found.
 *
 * @decision f432cbb8 — MUST stay synchronous (the hottest caller runs inside the M2 busy-gate drain
 * window's "no `await`" invariant); resolvedPathCache below is the load-bearing cost bound instead —
 * see the record for the measured cost and why the readdir scan itself is deliberately NOT cached.
 */
const RESOLVED_PATH_CACHE_MAX = 500; // mirrors walkState's MAX_TRACKED_WALKS bound in sessions/transcript.ts — never grows unbounded
const resolvedPathCache = new Map<string, string>(); // engineSessionId -> last-resolved fallback-scan hit

function rememberResolvedPath(engineSessionId: string, filePath: string): void {
  resolvedPathCache.delete(engineSessionId); // re-insert at the end (Map iteration order) as most-recent
  resolvedPathCache.set(engineSessionId, filePath);
  if (resolvedPathCache.size > RESOLVED_PATH_CACHE_MAX) {
    const oldest = resolvedPathCache.keys().next().value;
    if (oldest !== undefined) resolvedPathCache.delete(oldest);
  }
}

/** The real on-disk root every engine session's transcript lives under — the one place this literal is
 *  constructed (see this file's own header doc on why every `~/.claude/projects/...` path lives HERE). */
const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

export function resolveTranscriptFile(cwd: string, engineSessionId: string): string | null {
  const direct = engineTranscriptPath(cwd, engineSessionId);
  if (fs.existsSync(direct)) return direct;

  const cachedHit = resolvedPathCache.get(engineSessionId);
  if (cachedHit !== undefined) {
    if (fs.existsSync(cachedHit)) return cachedHit;
    resolvedPathCache.delete(engineSessionId); // stale — the file moved/vanished since caching; rescan for real
  }

  let found: string | null = null;
  try {
    // @decision 7d70b27b — correct-by-design: real engine session ids are Claude-CLI-minted UUIDs, so
    // cross-session collision here is implausible; a hermetic test must mint UUID-shaped ids too.
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_ROOT)) {
      const f = path.join(CLAUDE_PROJECTS_ROOT, dir, `${engineSessionId}.jsonl`);
      if (fs.existsSync(f)) { found = f; break; }
    }
  } catch { /* projects dir missing — nothing to find */ }
  if (found !== null) rememberResolvedPath(engineSessionId, found);
  return found;
}

/**
 * Build the FULL set of engine session ids that currently have an on-disk transcript ANYWHERE under
 * `~/.claude/projects`, in ONE pass — for a bulk "is X still resumable" sweep across MANY sessions (card
 * 9775559c's boot scratch-dir GC, `sessions/scratch-gc.ts`) where paying {@link resolveTranscriptFile}'s
 * own per-session fallback-scan cost (see its doc comment) for every candidate would multiply that cost by
 * however many candidates there are. This instead reads the root's own dir listing once, then one more
 * `readdirSync` per project dir (measured sub-second at this repo's own dev-box scale, ~1,256 dirs) — a
 * fundamentally cheaper shape for "check membership for N ids" than "resolve 1 id" repeated N times.
 * `root` defaults to the real {@link CLAUDE_PROJECTS_ROOT}; a test passes a fixture dir instead. Returns an
 * empty set (never throws) if the root doesn't exist.
 */
export function listAllTranscriptIds(root: string = CLAUDE_PROJECTS_ROOT): Set<string> {
  const ids = new Set<string>();
  let projectDirs: string[];
  try { projectDirs = fs.readdirSync(root); } catch { return ids; }
  for (const dir of projectDirs) {
    let files: string[];
    try { files = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const f of files) {
      if (f.endsWith(".jsonl")) ids.add(f.slice(0, -".jsonl".length));
    }
  }
  return ids;
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
 * @decision sha:5cb98ca4 — repairs a CONFIRMED engine-side JSONL comment-marker corruption at READ
 * time (can't be fixed at the source); the `\ `/`\*` leading-position check can't false-positive on
 * real content — see the record before changing this regex.
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
        // A tool that RETURNS an image (e.g. a browser/Playwright screenshot) has an "image" sub-block
        // here — mirror the top-level image handling in extractText so the turn doesn't fall back to
        // the bare "-> tool result" placeholder with no indication an image came back.
        else if (b.type === "image") parts.push("[image]");
      }
    }
    return repairMangledCommentMarkers(parts.join("\n"));
  }
  return "";
}

// A short correlation tag (last 8 chars of the full tool_use_id) embedded in both a tool_use turn's
// "[tool]" marker and its matching tool_result turn's "-> tool result" marker, so a reader scanning a
// transcript with many interleaved tool calls can visually pair a result back to its call — full ids
// are long opaque tokens (`toolu_01…`) that add noise; the tail is enough to disambiguate within one
// transcript (same convention as a git short SHA) without a schema change or a UI rendering change.
function shortToolTag(id: unknown): string {
  return typeof id === "string" && id.length > 0 ? ` {${id.slice(-8)}}` : "";
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
    // NOT truncated (card 68d85015 — previously a fixed 200-char slice, which silently ate a large
    // tool-call argument such as a worker_report body). A fixed cap here has no size that's ever right —
    // spill, don't widen: the full argument becomes part of this turn's `text`, so it's bounded the SAME
    // way the rest of the turn is — pageTranscript's per-page char budget, then spillableTurnsResponse's
    // overflow-to-scratch-file for a turn too large to inline — never truncated at the source.
    else if (c.type === "tool_use") parts.push(`[tool]${shortToolTag(c.id)} ${String(c.name ?? "")}(${JSON.stringify(c.input ?? {})})`);
    // A pasted screenshot with no caption text is a content array of ONLY an "image" block — without
    // this, the whole turn produces no text and parseTranscriptFile's `text.trim()` check drops it
    // silently (no placeholder at all, unlike the tool_result case right below), so an auditor can't
    // even tell a turn happened there.
    else if (c.type === "image") parts.push("[image]");
    else if (c.type === "tool_result") {
      // Retain the body (truncated) instead of collapsing to a bare placeholder, so an auditor can
      // verify error strings / structured returns rather than read only the agent's paraphrase.
      const tag = shortToolTag(c.tool_use_id);
      const errFlag = c.is_error === true ? " (error)" : "";
      const body = toolResultBody(c).trim();
      if (!body) { parts.push(`-> tool result${tag}${errFlag}`); continue; }
      const shown = body.length > TOOL_RESULT_BODY_CAP
        ? `${body.slice(0, TOOL_RESULT_BODY_CAP)}... [+${body.length - TOOL_RESULT_BODY_CAP} chars truncated]`
        : body;
      parts.push(`-> tool result${tag}${errFlag}: ${shown}`);
    }
  }
  return parts.join("\n");
}

/**
 * Claude Code submits a tool's result back to the engine as a JSONL entry with `type: "user"` — the
 * Anthropic Messages API models a tool_result as a "user"-role turn even though no human typed it. A
 * REAL human turn's content is a string or an array of "text"/"image" blocks; a tool-result submission's
 * content is an array of ONLY "tool_result" blocks. Reclassify the latter so the transcript view doesn't
 * mislabel a tool's output as something the human typed.
 */
function classifyRole(engineType: "user" | "assistant", content: unknown): TranscriptTurn["role"] {
  if (engineType === "assistant") return "assistant";
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result")
  ) {
    return "tool_result";
  }
  return "user";
}

/**
 * Parse one transcript JSONL file at `file` into clean, ordered turns — shared by every consumer that
 * needs to render a Claude engine transcript, live or archived (a Loom archive snapshot is a raw copy of
 * the same engine JSONL, so the wire format is identical either way; see `sessions/transcript.ts`'s
 * `readArchivedTranscript`, which imports this).
 */
export function parseTranscriptFile(file: string): TranscriptTurn[] {
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
    if (text.trim()) turns.push({ role: classifyRole(o.type, msg?.content), text });
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
