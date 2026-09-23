import fs from "node:fs";
import path from "node:path";
import { sessionScratchDir } from "./paths.js";

/** Below the cap: nothing was written, the caller inlines its payload as before. */
export interface SpillInline {
  inline: true;
}

/** Above the cap: `text` was written verbatim to `file` (UTF-8, real line breaks) — `chars` is its length. */
export interface SpillFile {
  inline: false;
  file: string;
  chars: number;
}

export type SpillResult = SpillInline | SpillFile;

// Mirrors the `repoKey` filesystem-path-segment guard (`projects/repos.ts` › `validateRepoRegistry`):
// `subdir`/`key` are joined straight into a path with no further sanitization, so an unrestricted value
// (`..`, `../elsewhere`, anything containing `/`/`\`) would let a caller escape the session scratch dir.
// `.`/`..` both match the charset below on their own, so they're rejected explicitly rather than relying
// on the regex to catch them. THROWS rather than sanitizing: a silently-rewritten key would make two
// distinct payloads collide on one filename — trading a security bug for a correctness one. Every
// legitimate caller already passes a valid segment, so this throw is unreachable in correct use.
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
function assertPathSegment(paramName: string, value: string): void {
  if (!PATH_SEGMENT_RE.test(value)) {
    throw new Error(
      `spillTextIfLarge: ${paramName} "${value}" must match [A-Za-z0-9._-]+ — it is used as a filesystem ` +
      "path segment, so slashes, backslashes, and other special characters are rejected",
    );
  }
  if (value === "." || value === "..") {
    throw new Error(`spillTextIfLarge: ${paramName} "${value}" is reserved — a filesystem path segment cannot be "." or ".."`);
  }
}

/**
 * The MCP tool-result INLINE budget, in characters — the threshold a `spillTextIfLarge` caller commonly
 * checks against to decide "does this text still fit inline in a tool response, or does it need to
 * spill." ~48KB is roughly 12K tokens — comfortably under the real MCP tool-result token cap, with
 * headroom for whatever envelope/JSON-quoting overhead wraps the text. Lives HERE, next to the spill
 * primitive itself, rather than being duplicated (or borrowed by name-only coincidence) per caller — a
 * caller with a genuinely different budget should define its OWN constant instead of reusing this one by
 * accident; this one is for "the general MCP inline cap," not for any one caller's specific page shape.
 *
 * @decision 26134f1a — MEASURED 2026-09-23 (claude 2.1.280): a real MCP response was observed inline at
 * 46,502 and 47,995 chars — the largest TESTED, never a proven ceiling. Bash stdout is a SEPARATE, much
 * lower mechanism (~28-33K) — never size this constant off it; re-measure both after a CLI upgrade.
 */
export const SPILL_INLINE_BUDGET_CHARS = 48_000;

/**
 * Persist `text` to `sessionId`'s own scratch dir (grep/Read-pageable — UTF-8, written verbatim so any
 * real line breaks the caller already shaped into `text` survive) when it exceeds `capChars`; a no-op
 * ({inline:true}) otherwise, so a caller under the cap is byte-identical to not calling this at all.
 * Deterministic path (`subdir`/`key`, not a fresh name per call) so repeated pulls of the same content
 * overwrite rather than accumulate scratch-dir garbage.
 *
 * Generalizes the pattern `SessionService.spillMergePatch` established for worker_merge's oversized
 * fullDiff (card 605988ab, following auditor finding 8a942a95): Loom decides to spill and controls the
 * format BEFORE a giant string ever reaches the MCP tool-result cap, rather than relying on the host
 * engine's own opaque overflow-spill (which JSON-escapes embedded newlines into a single unpageable
 * line). Callers must hand this ALREADY-shaped plain text — never re-run it through `JSON.stringify`,
 * or the very newlines this exists to preserve get escaped away again.
 */
export function spillTextIfLarge(sessionId: string, subdir: string, key: string, text: string, capChars: number): SpillResult {
  assertPathSegment("subdir", subdir);
  assertPathSegment("key", key);
  if (text.length <= capChars) return { inline: true };
  const dir = path.join(sessionScratchDir(sessionId), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key);
  fs.writeFileSync(file, text, "utf8");
  return { inline: false, file, chars: text.length };
}

/** Below the cap: nothing was written, the caller inlines `rows` as before. */
export interface SpillRowsInline<T> {
  inline: true;
  rows: T[];
}

/** Above the cap: `rows` was rendered as NDJSON and spilled to `file` — mirrors {@link SpillFile} plus
 *  `rowCount` and a ready-to-return `note` explaining the pointer. */
export interface SpillRowsFile {
  inline: false;
  file: string;
  chars: number;
  rowCount: number;
  note: string;
}

export type SpillRowsResult<T> = SpillRowsInline<T> | SpillRowsFile;

/**
 * The shared NDJSON-list-spill primitive (card eec70b79): renders `rows` as newline-delimited JSON (one
 * object per line, real line breaks) and spills it via {@link spillTextIfLarge} when it exceeds `capChars`
 * — the SAME shape `tasks_list`/`task_requests_list` (`mcp/server.ts`'s `okLinesSpillable`) and
 * `list_all_tasks` (`mcp/platform.ts`) already hand-roll independently. New list-shaped tool results that
 * can grow large should call this ONE function rather than re-deriving the "JSON.stringify per row, join
 * on \n, spillTextIfLarge, format a note" pattern a fourth/fifth/sixth time — it existed three times over
 * before this card, each byte-for-byte the same shape.
 *
 * Deliberately does NOT special-case `rows.length === 0` (the callers above return an explicit
 * `{tasks:[],message:"no matching tasks"}`-shaped payload themselves BEFORE reaching their own spill call)
 * — an empty array here is `capChars`-cheap and returns `{inline:true, rows:[]}` like any other under-cap
 * result, so a caller with its own "no matches" wording keeps deciding that itself.
 */
export function spillRowsIfLarge<T>(sessionId: string, subdir: string, key: string, rows: T[], capChars: number): SpillRowsResult<T> {
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  const spill = spillTextIfLarge(sessionId, subdir, key, text, capChars);
  if (spill.inline) return { inline: true, rows };
  const note =
    `${rows.length} rows are ${spill.chars} chars — too large to inline safely, so they were written to ` +
    `${spill.file} as NDJSON (one JSON object per line, real line breaks, UTF-8) — page it with Read ` +
    "(offset/limit are LINE-based) or grep it for a field/id. Re-call with a narrower filter/limit to inline fewer rows instead.";
  return { inline: false, file: spill.file, chars: spill.chars, rowCount: rows.length, note };
}

/**
 * {@link spillTextIfLarge}'s sibling for `agent_get`'s `startupPrompt` (card bf0fd0f3) — one large VALUE,
 * the SAME shape `spillableTaskGet` (`mcp/tasks.ts`) already gives `tasks_get`'s `body`, never the
 * many-rows NDJSON shape `spillRowsIfLarge` above serves. `agent_get` is registered on three routers
 * (manager `mcp/orchestration.ts`, platform `mcp/platform.ts`, setup `mcp/setup.ts`), each projecting a
 * differently-shaped agent record — this is generic over any of them (`T extends { startupPrompt:
 * string }`) so every caller shares one spill primitive instead of three independently-drifting copies.
 * `key` should be deterministic per agent (its own resolved id) so repeated reads of the same agent
 * overwrite rather than accumulate scratch-dir garbage — mirrors `spillTextIfLarge`'s own contract.
 *
 * BELOW the cap: returns `agent` untouched — byte-identical to before this existed.
 * ABOVE the cap: returns `agent` with `startupPrompt` replaced by `startupPromptFile`/`startupPromptChars`
 * plus a `note`; every other field stays inline since only the prompt is unbounded.
 */
export function spillableAgentGet<T extends { startupPrompt: string }>(
  sessionId: string, subdir: string, key: string, agent: T,
): T | (Omit<T, "startupPrompt"> & { startupPromptFile: string; startupPromptChars: number; note: string }) {
  const spill = spillTextIfLarge(sessionId, subdir, key, agent.startupPrompt, SPILL_INLINE_BUDGET_CHARS);
  if (spill.inline) return agent;
  const { startupPrompt: _startupPrompt, ...rest } = agent;
  const note =
    `startupPrompt is ${spill.chars} chars — too large to inline safely, so the plain text (real line ` +
    `breaks, UTF-8) was written to ${spill.file}. Read it directly, or grep it for a substring; slice by ` +
    "character range via Bash if a single line is too long to page.";
  return { ...rest, startupPromptFile: spill.file, startupPromptChars: spill.chars, note };
}
