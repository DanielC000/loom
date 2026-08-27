import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptTurn } from "./adapter.js";

/**
 * HarnessAdapter seam (card 2b099e48, Phase 0 of the multi-harness epic df1f94b0): this file is the
 * claude adapter's OWNERSHIP of the engine transcript's on-disk location + JSONL wire format. Every
 * literal `~/.claude/projects/...` path construction and every assumption about the shape of a Claude
 * Code transcript line (`type: "user"|"assistant"`, `message.content` blocks, `tool_use`/`tool_result`)
 * lives HERE and nowhere else — moved out of `sessions/transcript.ts` (formerly the sole owner) so that
 * file can hold only the harness-AGNOSTIC half (pagination, spill, Loom's own archive store), which
 * operates on the generic {@link TranscriptTurn} shape regardless of which harness produced it.
 * `sessions/transcript.ts` re-exports every name below UNCHANGED for its 13 existing consumers — see its
 * own header comment — so this move is a pure relocation with zero call-site churn and zero behavior
 * change (verified: see the pty test suite, in particular `transcript-encode.mjs` and
 * `real-homedir-transcript-leak-isolation.mjs`).
 *
 * `TranscriptTurn` itself is DEFINED in `pty/adapter.ts` (Code Review MAJOR-2, card 2b099e48) — it is the
 * harness-AGNOSTIC contract type every future adapter's `readTranscript` returns, so it belongs with the
 * interface, not inside adapter #1's own implementation. Re-exported here so nothing downstream needs to
 * change its import path.
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
 * Locate a session's transcript file robustly: the computed path first (fast, correct for the
 * common case), else scan `~/.claude/projects/*` for `<engineSessionId>.jsonl` — the id is a
 * globally-unique UUID, so a match is unambiguous regardless of how Claude encoded the dir. This
 * makes transcript reads resilient to any future dir-encoding drift. Returns null if not found.
 *
 * DoD-3 determination (card 7d70b27b, the second reader to ask this) — TWO SEPARATE QUESTIONS, only one
 * of them settled by "engine ids are UUIDs":
 *
 * CORRECTNESS — can this scan resolve to the WRONG file? The global fallback scan below is
 * CORRECT-BY-DESIGN for production and is NOT being changed here. Every real engine session id is a
 * Claude-CLI-minted UUID, so an accidental collision between two DIFFERENT sessions is implausible — the
 * scan's whole reason to exist (dir-encoding drift resilience, see encodeProjectDir's own doc comment)
 * depends on exactly that global-uniqueness property. The production defect this card actually fixes
 * lives entirely on the TEST side: `test/engine-session-rotation.mjs` used to write FIXED literal ids
 * ("engine-session-alpha/beta/gamma/delta") instead of real UUIDs, so a leftover from one run could
 * collide with a later run's lookup for the exact same literal name — a hazard this function's own
 * contract doesn't create and can't detect. Any HERMETIC test that exercises this scan must mint
 * globally-unique-shaped ids (e.g. suffixed with `${Date.now()}-${process.pid}`) for the same reason
 * real engine ids already are unique — not because this function should scope its search.
 *
 * COST — what does this scan PAY, regardless of correctness? This is NOT settled by the UUID argument,
 * and is a real, currently-unbounded, currently-growing production cost: measured against this repo's
 * OWN dev box, `~/.claude/projects/` held 5772 directories, ~69% of them test-run leakage (a handful of
 * `test/*.mjs` files write real-homedir fixtures — via {@link engineTranscriptPath} above — under a
 * unique-but-never-cleaned-up directory per run; see project memory
 * `real-homedir-transcript-leak-sibling-audit` for the accounting). `fs.readdirSync(root)` here walks
 * EVERY one of those entries on every fallback hit, so the scan's wall-clock cost scales with however
 * much test garbage has accumulated on the host, not with anything about the session being looked up.
 * That's a distinct problem from this card's scope (fixing it means bounding or cleaning the leak
 * sources, not changing this function) but it's a real, measured cost this determination should not be
 * read as dismissing.
 *
 * BOUNDING THE COST (card f432cbb8, the third reader to ask this) — this does NOT change the fallback's
 * existence or its correctness reasoning above; it bounds what the fallback PAYS, same as the manager's
 * own framing. Measured (project memory `resolve-transcript-file-fallback-scan-cost-measured`): the
 * worst case (direct miss, target genuinely not found) was ~169–239ms SYNCHRONOUS wall-clock against this
 * repo's own `~/.claude/projects` (5778 dirs) — and it's synchronous because it HAS to be: the hottest
 * caller, {@link readContextStats} (sessions/context.ts) via `pty/host.ts`'s `deliverHook` Stop-hook
 * handler, runs inside the M2 busy-gate drain window, which is a documented "DO NOT INTRODUCE AN `await`
 * IN THIS BRANCH" invariant — an async signature here is not available as an option for that call site.
 *
 * `resolvedPathCache` (engine session id -> resolved file path) closes the case that actually dominates
 * in practice: a REPEAT lookup for an id this function has already found via the fallback scan skips the
 * scan entirely — a live session's context-stats read re-resolves the SAME id on every Stop. A hit is
 * revalidated with a single `existsSync` before being trusted (the file could have been removed since
 * caching); a stale hit is dropped and falls through to a real scan, never returned as-is. This has no
 * coherence hole: a cache MISS here always falls through to the full scan below, unchanged.
 *
 * ⚠️ WHY THERE IS NO CACHE ON THE `readdir` ITSELF (an earlier draft of this fix had one — deliberately
 * removed, not merely never added): measured separately, `readdirSync` alone costs ~8ms at 5778 entries;
 * the `existsSync`-per-candidate loop alone costs ~249ms. The `readdir` was measured NOT to be the
 * bottleneck, so caching it saves ~3% of the worst case at best — and a TTL-cached listing has a
 * coherence hole a fresh `readdir` cannot: engine session ROTATION (see above) writes a NEW file into an
 * ALREADY-EXISTING project dir, so any "only re-check dirs new since the cached listing" optimization
 * silently EXCLUDES the one dir that actually changed, producing a false not-found for a transcript that
 * genuinely exists (self-healing once the cache would have expired, but still a real regression against
 * a plain fresh scan). Not a hypothetical: `readContextStats` calls this on every Stop hook specifically
 * because rotation is the documented reason the fallback exists at all (see `45274e34` above), so the
 * excluded case is the fallback's OWN primary use case. A bad trade at any TTL — deleted rather than
 * patched. See `test/transcript-fallback-cache-coherence.mjs` for the regression guard covering
 * `resolvedPathCache`'s own two failure shapes (a deleted cached file must rescan; a NEW file written
 * into an already-resolved-once dir must still resolve on the next distinct lookup).
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

export function resolveTranscriptFile(cwd: string, engineSessionId: string): string | null {
  const direct = engineTranscriptPath(cwd, engineSessionId);
  if (fs.existsSync(direct)) return direct;

  const cachedHit = resolvedPathCache.get(engineSessionId);
  if (cachedHit !== undefined) {
    if (fs.existsSync(cachedHit)) return cachedHit;
    resolvedPathCache.delete(engineSessionId); // stale — the file moved/vanished since caching; rescan for real
  }

  const root = path.join(os.homedir(), ".claude", "projects");
  let found: string | null = null;
  try {
    for (const dir of fs.readdirSync(root)) {
      const f = path.join(root, dir, `${engineSessionId}.jsonl`);
      if (fs.existsSync(f)) { found = f; break; }
    }
  } catch { /* projects dir missing — nothing to find */ }
  if (found !== null) rememberResolvedPath(engineSessionId, found);
  return found;
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
