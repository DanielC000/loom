import fs from "node:fs";
import path from "node:path";
import type { TranscriptTurn } from "./adapter.js";
import { archivedTranscriptPath } from "../sessions/transcript.js";
import { realCodexHome } from "./codex-doctrine.js";
import { codexRolloutArchiveRoot } from "./codex-rollout-archive.js";

/**
 * HarnessAdapter seam (multi-harness epic df1f94b0, Phase 1, card 353f6dc4): the codex adapter's
 * ownership of the engine transcript's on-disk location + JSONL wire format — the codex-side mirror of
 * `pty/claude-transcript.ts`. Every `~/.codex/sessions/...` path construction and every assumption about
 * the shape of a Codex CLI rollout record lives HERE.
 *
 * ## Ground truth this file is built on (NOT inferred from docs)
 * Verified directly against three real `rollout-*.jsonl` files this host's `codex-cli 0.153.4` produced
 * during the prior probe card (`a7d74718`) — structure only (record types + JSON keys), never prose
 * content, matching that card's own read-structure-not-content discipline. Confirmed record shapes:
 *  - `{type:"session_meta", payload:{session_id,id,timestamp,cwd,originator,cli_version,source,
 *    thread_source,model_provider,base_instructions,history_mode,context_window,git}}` — always the
 *    first line.
 *  - `{type:"response_item", payload:{type:"message", id, role, content:[{type,text,...}],
 *    internal_chat_message_metadata_passthrough}}` — `role` observed as `"user"`/`"developer"`;
 *    `content[0].type` observed as `"input_text"`.
 *  - `{type:"event_msg", payload:{type:"task_started"|"item_completed"|"task_complete"|
 *    "thread_settings_applied"|"token_count"|"turn_aborted", ...}}`.
 *  - `{type:"turn_context", payload:{...}}`, `{type:"world_state", payload:{full,state}}` — session
 *    bookkeeping, not turn content.
 *
 * ## ⚠️ NAMED GAP — do not read this parser as fully verified
 * Every real sample available on this host came from the prior probe's deliberately trivial one-word
 * ("pong") exchanges — no substantive assistant reply or tool call was ever captured as its own
 * `response_item`. I did **not** observe `role:"assistant"` on a `response_item`, nor any
 * `item_completed.item.type` other than `"UserMessage"`, nor a populated `token_count.info` (it was `{}`
 * in every sample — the field NAMES a real usage payload exists, per the `--help`-adjacent record type,
 * but its actual shape when populated is UNCONFIRMED). Re-spending the owner's subscription to force a
 * substantive session purely to firm up this parser was judged not worth it for this pass (see the
 * card's own "keep model turns minimal" constraint) — this is a deliberate, disclosed gap, not an
 * oversight. `readTranscript` below handles the CONFIRMED shapes plus a defensive fallback
 * (`task_complete.last_agent_message`, a field OpenAI's own naming makes unambiguous even unobserved)
 * for the assistant side; `readContextStats`/`readCumulativeUsage` are deliberately NOT implemented (see
 * `codex-adapter.ts`) rather than guessing at unconfirmed field names that would silently misreport.
 */
export type { TranscriptTurn };

/** Computed fresh on every call (never cached at module load) so a test that sets `CODEX_HOME` before
 *  calling into this module — never before importing it — gets genuine isolation, and so the exact
 *  same knob {@link realCodexHome} documents (a real per-worker override is empirically broken; see its
 *  own doc) governs this lookup root too, rather than a second, independently-hardcoded `os.homedir()`
 *  call that could silently drift from it. */
function codexSessionsRoot(): string {
  return path.join(realCodexHome(), "sessions");
}

/**
 * Tolerates mtime/wall-clock skew when matching a just-written codex rollout file's `mtimeMs` against
 * `sinceMs` in {@link findConversationIdForSpawn}'s freshness filter.
 *
 * @decision 49d43ef9 — keep this SMALL: measured skew is sub-2ms, so a wide "safe-feeling" tolerance
 * (e.g. a round 2000ms) would widen the same window that lets the recycle race through. Bounds, does
 * not close, the race — `excludeSessionIds` (card cbae4520) closes that shape by construction instead.
 *
 * Env-overridable so a hermetic test can exercise the boundary without waiting on real skew (mirrors this
 * project's `LOOM_CODEX_*_MS` convention in `pty/host.ts`).
 */
export const MTIME_SKEW_TOLERANCE_MS = Number(process.env.LOOM_CODEX_MTIME_SKEW_TOLERANCE_MS) || 100;

/** Bounded cache mirroring `claude-transcript.ts#resolvedPathCache` — a repeat lookup for an id already
 *  found by the recursive scan below skips rescanning the whole dated tree. */
const RESOLVED_PATH_CACHE_MAX = 500;
const resolvedPathCache = new Map<string, string>();
function rememberResolvedPath(conversationId: string, filePath: string): void {
  resolvedPathCache.delete(conversationId);
  resolvedPathCache.set(conversationId, filePath);
  if (resolvedPathCache.size > RESOLVED_PATH_CACHE_MAX) {
    const oldest = resolvedPathCache.keys().next().value;
    if (oldest !== undefined) resolvedPathCache.delete(oldest);
  }
}

/** Walk one `YYYY/MM/DD`-shaped root looking for a `.jsonl` file whose name contains `conversationId` —
 *  the shared tree-walk {@link resolveTranscriptFile} runs against BOTH the live sessions root and the
 *  archive root (card b8124a1f, `codex-rollout-archive.ts`). */
function scanForConversationId(root: string, conversationId: string): string | null {
  try {
    for (const year of fs.readdirSync(root)) {
      const yearDir = path.join(root, year);
      let months: string[];
      try { months = fs.readdirSync(yearDir); } catch { continue; }
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        let days: string[];
        try { days = fs.readdirSync(monthDir); } catch { continue; }
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files: string[];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          const hit = files.find((f) => f.endsWith(".jsonl") && f.includes(conversationId));
          if (hit) return path.join(dayDir, hit);
        }
      }
    }
  } catch { /* root missing — nothing to find */ }
  return null;
}

/**
 * Locate a conversation's rollout file. Unlike Claude's per-cwd-encoded-dir + `<id>.jsonl` scheme, a
 * Codex rollout filename is `rollout-<ISO-timestamp>-<uuid>.jsonl` nested under `sessions/YYYY/MM/DD/` —
 * the `cwd` isn't part of the path at all (confirmed: `session_meta.payload.cwd` carries it INSIDE the
 * file instead), so there is no direct/computed path to try first the way Claude's `engineTranscriptPath`
 * has. Every lookup is a scan; bounded to `depth:3` (YYYY/MM/DD) and cached by conversation id so a
 * repeat lookup (e.g. a live session's own liveness re-check) doesn't re-walk the tree.
 *
 * @decision b8124a1f — an archived rollout is a byte-identical relocation, never a transform: the
 * {@link codexRolloutArchiveRoot} fallback keeps every caller working unchanged whether a session's
 * rollout file is live or archived. Never special-case an archived session here.
 */
export function resolveTranscriptFile(_cwd: string, conversationId: string): string | null {
  const cachedHit = resolvedPathCache.get(conversationId);
  if (cachedHit !== undefined) {
    if (fs.existsSync(cachedHit)) return cachedHit;
    resolvedPathCache.delete(conversationId);
  }
  const found =
    scanForConversationId(codexSessionsRoot(), conversationId) ??
    scanForConversationId(codexRolloutArchiveRoot(), conversationId);
  if (found !== null) rememberResolvedPath(conversationId, found);
  return found;
}

export function transcriptExists(cwd: string, conversationId: string): boolean {
  return resolveTranscriptFile(cwd, conversationId) !== null;
}

/**
 * Bounded cache of `readSessionMeta`'s per-file result, keyed by absolute file path — mirrors
 * `resolvedPathCache` above (same size cap, same LRU-by-reinsertion eviction). A rollout file's FIRST line
 * never changes after creation (this file's own header: `session_meta` is always written first), so once
 * read it can be trusted indefinitely; the `mtimeMs`+`size` stamp is a defensive staleness check only (it
 * should never actually fire for a real rollout file — nothing this project does ever rewrites one).
 *
 * @decision cbae4520 — do not remove or unbound this cache: without it, the corpus-wide spawn-hot-path
 * scan re-reads every candidate rollout file's content on every fresh codex spawn (measured 74.2ms vs
 * ~5.7ms cached, 242-file corpus) — synchronous, on the spawn hot path.
 */
const SESSION_META_CACHE_MAX = 500;
const sessionMetaCache = new Map<string, { mtimeMs: number; size: number; sessionId: string; cwd: string }>();
function rememberSessionMeta(file: string, entry: { mtimeMs: number; size: number; sessionId: string; cwd: string }): void {
  sessionMetaCache.delete(file);
  sessionMetaCache.set(file, entry);
  if (sessionMetaCache.size > SESSION_META_CACHE_MAX) {
    const oldest = sessionMetaCache.keys().next().value;
    if (oldest !== undefined) sessionMetaCache.delete(oldest);
  }
}

/**
 * Read a file up to (not including) its first `\n`, in bounded 4KB chunks — never the whole file. Card
 * `cbae4520` code review [1]: a rollout file's `session_meta` line can be large (measured on the same real
 * corpus: ALL 242 real first lines exceeded 8KB, max 22,311 bytes — `base_instructions` is inlined into it)
 * — so a fixed read cap would truncate a real one, and reading incrementally until the newline is actually
 * found decouples cost from conversation length instead (measured 78.8ms → 52.1ms on that same corpus, on
 * top of the cache above). `0x0a` ("\n") can never appear as part of a multi-byte UTF-8 continuation
 * sequence (those are always ≥0x80), so a raw byte search across chunk boundaries is safe — the eventual
 * `toString("utf8")` decode always happens on a byte range that starts a fresh line. Never throws.
 */
function readFirstLine(file: string): string | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    for (;;) {
      let n: number;
      try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch { return null; }
      if (n <= 0) break; // EOF before any newline — whatever was read (if anything) is the "first line"
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Read a rollout file's FIRST line only and, iff it's a `session_meta` record, return its
 *  `{session_id, cwd}` — the two fields {@link findConversationIdForSpawn} needs to match a candidate file
 *  against a spawn. Confirmed shape: `session_meta` is always the first line (this file's own header).
 *  Cached (see {@link sessionMetaCache}'s own doc) and reads incrementally (see {@link readFirstLine}'s own
 *  doc), never the whole file. */
function readSessionMeta(file: string): { sessionId: string; cwd: string } | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = sessionMetaCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { sessionId: cached.sessionId, cwd: cached.cwd };
  }
  const firstLine = readFirstLine(file);
  if (!firstLine || !firstLine.trim()) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(firstLine); } catch { return null; }
  if (o.type !== "session_meta") return null;
  const payload = o.payload as Record<string, unknown> | undefined;
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (typeof sessionId !== "string" || typeof cwd !== "string") return null;
  const resolvedCwd = path.resolve(cwd);
  rememberSessionMeta(file, { mtimeMs: stat.mtimeMs, size: stat.size, sessionId, cwd: resolvedCwd });
  return { sessionId, cwd: resolvedCwd };
}

/**
 * Discovers a fresh spawn's own codex conversation id: no id is known yet, so cwd + recency is the only
 * available correlator (unlike {@link resolveTranscriptFile}, which matches an ALREADY-KNOWN id against a
 * filename substring). Scans every rollout file created at/after `sinceMs` (a cheap `stat`-only filter
 * before ever reading a candidate's content) and returns the `session_id` of the newest one whose OWN
 * `session_meta.payload.cwd` matches `cwd`; returns null (never throws) when nothing matches, including a
 * genuinely-not-yet-written file — the caller (`pty/host.ts`'s `captureCodexEngineSessionId`) is
 * responsible for any retry.
 *
 * @decision 2ec60d9c — a discovery SCAN, not a hook report: codex has no SessionStart-hook equivalent to
 * report its own conversation id, so `CodexLive.engineSessionId` (`pty/host.ts`) would stay permanently
 * null without this — codex writes `session_meta` essentially at conversation start, well before any TUI.
 *
 * @decision cbae4520 — `excludeSessionIds` skips a candidate OUTRIGHT regardless of mtime/skew, closing
 * the SEQUENTIAL recycle-race shape by construction (identity, not timing). Never pass it for a caller
 * that must still match a pre-existing file, e.g. a resume spawn re-discovering its own.
 */
export function findConversationIdForSpawn(cwd: string, sinceMs: number, excludeSessionIds?: ReadonlySet<string>): string | null {
  const resolvedCwd = path.resolve(cwd);
  let best: { sessionId: string; mtimeMs: number } | null = null;
  try {
    const sessionsRoot = codexSessionsRoot();
    for (const year of fs.readdirSync(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      let months: string[];
      try { months = fs.readdirSync(yearDir); } catch { continue; }
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        let days: string[];
        try { days = fs.readdirSync(monthDir); } catch { continue; }
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files: string[];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            const full = path.join(dayDir, f);
            let mtimeMs: number;
            try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
            // Cheap stat-only pre-filter (same predicate as candidateVerdict's first rung) so a stale file
            // is never content-read; the newest-wins skip below likewise precedes the content read.
            if (mtimeMs < sinceMs - MTIME_SKEW_TOLERANCE_MS) continue;
            if (best && mtimeMs <= best.mtimeMs) continue; // already have a newer-or-equal match
            const v = candidateVerdict(full, mtimeMs, resolvedCwd, sinceMs, excludeSessionIds);
            if (v.verdict !== "match") continue;
            best = { sessionId: v.sessionId, mtimeMs };
          }
        }
      }
    }
  } catch { /* sessions root missing — nothing to find yet */ }
  return best?.sessionId ?? null;
}

type CandidateVerdict =
  | { verdict: "match"; sessionId: string }
  | { verdict: "stale-mtime" | "no-session-meta" | "cwd-mismatch" | "excluded-predecessor"; sessionId?: string; metaCwd?: string };

/**
 * The single per-candidate match predicate, shared by {@link findConversationIdForSpawn} (acts on `match`)
 * and {@link describeRolloutCandidatesForDiagnostic} (reports why a candidate did not match), so the
 * give-up diagnostic can never disagree with the matcher (card a1ad730a). Rungs, in order: mtime
 * freshness (card 49d43ef9) → readable `session_meta` → cwd equality → not a known predecessor id (card
 * cbae4520: never adopt one).
 */
function candidateVerdict(
  full: string,
  mtimeMs: number,
  resolvedCwd: string,
  sinceMs: number,
  excludeSessionIds: ReadonlySet<string> | undefined,
): CandidateVerdict {
  if (mtimeMs < sinceMs - MTIME_SKEW_TOLERANCE_MS) return { verdict: "stale-mtime" };
  const meta = readSessionMeta(full);
  if (!meta) return { verdict: "no-session-meta" };
  if (meta.cwd !== resolvedCwd) return { verdict: "cwd-mismatch", sessionId: meta.sessionId, metaCwd: meta.cwd };
  if (excludeSessionIds?.has(meta.sessionId)) return { verdict: "excluded-predecessor", sessionId: meta.sessionId, metaCwd: meta.cwd };
  return { verdict: "match", sessionId: meta.sessionId };
}

/** Bounds for {@link describeRolloutCandidatesForDiagnostic}. */
export const ROLLOUT_DIAG_MAX_CANDIDATES = 10;
export const ROLLOUT_DIAG_MAX_CHARS = 2000;
const DIAG_WINDOW_LEAD_MS = 36 * 60 * 60 * 1000;

/**
 * Card a1ad730a: ONE bounded, best-effort line for `captureCodexEngineSessionId`'s give-up log — the
 * sessions root searched, the spawn's cwd/startedAt, and the newest rollout files with the matcher's own
 * verdict for each — so a failure reads "created but unmatched" (candidates with a reason) vs "never
 * created" (none present / none fresh). Never throws; capped at {@link ROLLOUT_DIAG_MAX_CHARS}. Stats the
 * whole corpus once, acceptable at a single give-up.
 */
export function describeRolloutCandidatesForDiagnostic(cwd: string, sinceMs: number, excludeSessionIds?: ReadonlySet<string>): string {
  let root = "?";
  try {
    root = codexSessionsRoot();
    const resolvedCwd = path.resolve(cwd);
    const all: { name: string; full: string; mtimeMs: number }[] = [];
    const ls = (d: string): string[] => { try { return fs.readdirSync(d); } catch { return []; } };
    // Event-loop discipline: this runs synchronously in the daemon, so walk ONLY the day dirs a rollout
    // created at/after this spawn can live in — never the whole multi-month corpus. A day dir is in-window
    // iff its YYYY-MM-DD >= the UTC date of (sinceMs - DIAG_WINDOW_LEAD_MS); the lead absorbs codex naming
    // its day dir by local date while this compares UTC. (The matcher itself has no day-dir window: it
    // walks every dir and stats every file — see findConversationIdForSpawn.)
    const lo = new Date(sinceMs - DIAG_WINDOW_LEAD_MS).toISOString().slice(0, 10);
    const days: string[] = [];
    for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
      if (`${y}-${m}-${d}` < lo) continue;
      days.push(`${y}/${m}/${d}`);
      for (const f of ls(path.join(root, y, m, d))) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(root, y, m, d, f);
        try { all.push({ name: f, full, mtimeMs: fs.statSync(full).mtimeMs }); } catch { /* vanished */ }
      }
    }
    const shownDays = days.length > 5 ? [...days.slice(0, 5), `+${days.length - 5} more`] : days;
    const head = `searched=${root} searchedDays=${shownDays.join(",") || `none (on/after ${lo})`} spawnCwd=${resolvedCwd} startedAt=${new Date(sinceMs).toISOString()} rolloutsInWindow=${all.length}`;
    if (all.length === 0) return clampDiag(`${head} candidates=none present in window`);
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const parts = all.slice(0, ROLLOUT_DIAG_MAX_CANDIDATES).map((c) => {
      const v = candidateVerdict(c.full, c.mtimeMs, resolvedCwd, sinceMs, excludeSessionIds);
      const detail = v.verdict === "cwd-mismatch" ? ` metaCwd=${v.metaCwd}` : v.verdict === "match" ? ` id=${v.sessionId}` : "";
      const skew = Math.round(c.mtimeMs - sinceMs);
      return `${c.name} mtime=${new Date(c.mtimeMs).toISOString()} (${skew >= 0 ? "+" : ""}${skew}ms vs start) verdict=${v.verdict}${detail}`;
    });
    return clampDiag(`${head} candidates(newest ${parts.length}): ${parts.join(" | ")}`);
  } catch (err) {
    return clampDiag(`searched=${root} diagnostic-failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

function clampDiag(s: string): string {
  const one = s.replace(/[\r\n]+/g, " ");
  return one.length > ROLLOUT_DIAG_MAX_CHARS ? `${one.slice(0, ROLLOUT_DIAG_MAX_CHARS)}…[truncated]` : one;
}

/**
 * Card `cbae4520`: snapshot every rollout file's `session_id` ALREADY on disk whose `session_meta.cwd`
 * matches `cwd` — regardless of mtime, unlike {@link findConversationIdForSpawn}'s own freshness scan.
 * Intended to be called by `pty/host.ts`'s `spawnCodexProcess` IMMEDIATELY BEFORE it creates the new codex
 * process for a genuinely fresh (non-`resume`) spawn, then threaded back into that same spawn's own
 * {@link findConversationIdForSpawn} calls as `excludeSessionIds` for the lifetime of the retry ladder.
 *
 * WHY THIS CLOSES THE SEQUENTIAL-REUSE SHAPE BY CONSTRUCTION, NOT BY TIMING MARGIN: a fresh (non-resume)
 * spawn's own rollout file cannot possibly exist yet at the instant this snapshot is taken — the codex
 * process that will eventually write it hasn't been created. So every id this returns is, by definition,
 * some OTHER conversation's file that was ALREADY on disk before this spawn began (a predecessor's, from
 * this generation or an earlier one sharing the same recycled worktree cwd) — never this spawn's own.
 * Excluding exactly this set removes every SEQUENTIAL false-adoption candidate without narrowing (or
 * depending on) the mtime tolerance at all: it holds regardless of clock skew, retry timing, or how close
 * together the predecessor's last write and this spawn's own first write land. A resume spawn must NEVER
 * receive this exclusion — resume's whole point is to legitimately re-match its own ALREADY-EXISTING file,
 * which this snapshot would otherwise exclude.
 *
 * ⚠️ WHAT THIS DOES NOT CLOSE, AND STILL DOESN'T (code review [2], card cbae4520; card `7a0b826e` after
 * it): the snapshot is frozen at THIS spawn's own start, while the capture retry ladder keeps scanning for
 * up to `CODEX_ENGINE_ID_MAX_ATTEMPTS × CODEX_ENGINE_ID_RETRY_MS` (≈120s, `pty/host.ts`) afterward, and
 * that scan prefers the newest mtime. A DIFFERENT fresh spawn into the SAME cwd, created AFTER this
 * snapshot was taken (e.g. two workers dispatched to the same project `repoPath` within that ~120s window),
 * writes a rollout file that is invisible to THIS spawn's exclusion set and can still be exactly what this
 * spawn's own scan adopts — a CONCURRENT-reuse shape, narrower than and distinct from the sequential one
 * this snapshot closes, and pre-existing in kind (not introduced by this card).
 *
 * **Card `7a0b826e` MEASURED this shape reachable** — no spawn lock exists anywhere in `sessions/
 * service.ts` or `pty/host.ts` (checked directly), and at least seven fresh-spawn call sites there share
 * `cwd: project.repoPath`, so nothing serialises two fresh codex spawns to one project root. That same card
 * then tried, and ABANDONED, an in-scan mitigation (rejecting a candidate already claimed by a live
 * sibling): refusing a contested candidate systematically punishes whichever session is the RIGHTFUL
 * owner of that file (the thief has already captured and stopped scanning; the owner is the one still
 * being told "not yours") — every variant tried either reproduced a two-way identity swap when the
 * candidate set shifted mid-ladder, or left the rightful owner with no id at all, which is worse than the
 * plain race (a plain race leaves one wrong + one correct capture sharing one id, at least detectable by a
 * uniqueness sweep). The scan has no identity information — no signal tying a codex process to its own
 * rollout file — to resolve this with, so nothing at THIS layer closes it. Real closure needs either a
 * genuine spawn-time identity correlator (none found in the codex CLI's own flags/docs as of this writing)
 * or serialising fresh codex spawns per cwd — both tracked at card `184fd82e`, not here. `pty/host.ts` and
 * `test/codex-recycle-conversation-id-exclusion.mjs`/`test/codex-concurrent-same-cwd-exclusion.mjs`
 * deliberately point back here rather than repeating this, so it can't drift out of sync. Do not read this
 * function's own certainty about the sequential case as covering the concurrent one too.
 *
 * @decision 184fd82e — do not adopt a per-cwd spawn lock off the ~120s retry-ladder ceiling alone —
 * that ceiling is a configured worst case, not a measured collision cost. `captureCodexEngineSessionId`
 * (host.ts) instead logs the real exposure; the race is NOT fixed, only its visibility changed.
 *
 * Reads every matching file's `session_meta` (not just `stat`s it, unlike the freshness scan above) since
 * cwd is only knowable from content — cached and read incrementally, never the whole file (see
 * `readSessionMeta`'s own doc) — bounded to the same `depth:3` (YYYY/MM/DD) tree walk; never throws. A
 * missing `sessions` root (this host has never run codex) is the only silently-tolerated outcome — any
 * OTHER failure mid-walk (EMFILE/EACCES on a busy daemon, say) is disclosed via `console.warn`, since a
 * silent empty result here means the exclusion this card added is NOT active for this spawn, which would
 * otherwise fail OPEN with no visible sign.
 */
export function snapshotExistingConversationIdsForSpawn(cwd: string): Set<string> {
  const resolvedCwd = path.resolve(cwd);
  const ids = new Set<string>();
  try {
    const sessionsRoot = codexSessionsRoot();
    for (const year of fs.readdirSync(sessionsRoot)) {
      const yearDir = path.join(sessionsRoot, year);
      let months: string[];
      try { months = fs.readdirSync(yearDir); } catch { continue; }
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        let days: string[];
        try { days = fs.readdirSync(monthDir); } catch { continue; }
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files: string[];
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            const meta = readSessionMeta(path.join(dayDir, f));
            if (meta && meta.cwd === resolvedCwd) ids.add(meta.sessionId);
          }
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn(`[codex-transcript] snapshotExistingConversationIdsForSpawn(${cwd}) failed unexpectedly (${(err as NodeJS.ErrnoException)?.code ?? "?"}) — falling back to an EMPTY exclusion set, which means card cbae4520's recycle-race guard is NOT active for this spawn: ${(err as Error)?.message ?? String(err)}`);
    }
    // ENOENT (sessions root missing) is the expected, silent case — nothing pre-exists yet.
  }
  return ids;
}

/** Pull display text out of a `response_item` content array (`content[0].type === "input_text"`
 *  confirmed; `"output_text"` handled defensively — the documented Responses-API-style counterpart to
 *  `input_text`, unobserved on this host per this file's own header gap note). */
function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function classifyRole(role: unknown): TranscriptTurn["role"] {
  if (role === "assistant") return "assistant";
  // "developer" (the system/instruction-carrying role observed on this host) maps to "system" (card
  // 100c523f — the fourth bucket pty/adapter.ts's TranscriptTurn.role union added for exactly this): a
  // developer-authored line is not something a human typed, so folding it into "user" would silently
  // mislabel it. Anything else observed on this role (there is no third value seen on this host) falls
  // back to "user" rather than guessing at an unconfirmed shape.
  if (role === "developer") return "system";
  return "user";
}

/**
 * Parse one rollout JSONL file into ordered, harness-agnostic turns.
 *
 * @decision ca9c4e34 — do not remove the `sawAssistantResponseThisTurn` guard below; without it a turn
 * whose reply is captured by both a real response_item AND task_complete's own echo renders twice.
 */
export function parseTranscriptFile(file: string): TranscriptTurn[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const turns: TranscriptTurn[] = [];
  let sawAssistantResponseThisTurn = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    const payload = o.payload as Record<string, unknown> | undefined;
    if (o.type === "event_msg" && payload?.type === "task_started") {
      sawAssistantResponseThisTurn = false;
      continue;
    }
    if (o.type === "response_item" && payload?.type === "message") {
      const text = extractContentText(payload.content);
      if (text.trim()) {
        const role = classifyRole(payload.role);
        if (role === "assistant") sawAssistantResponseThisTurn = true;
        turns.push({ role, text });
      }
      continue;
    }
    // Defensive fallback (UNCONFIRMED shape — see this file's header gap note): task_complete's
    // last_agent_message is the one documented-by-naming place an assistant reply could live when it
    // never appears as its own response_item. Guarded by sawAssistantResponseThisTurn (card ca9c4e34) so
    // it never re-renders a reply a response_item already captured for THIS turn.
    if (o.type === "event_msg" && payload?.type === "task_complete") {
      if (!sawAssistantResponseThisTurn && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
        turns.push({ role: "assistant", text: payload.last_agent_message });
      }
      // card ca9c4e34 (manager review): reset HERE too, not only on task_started — task_complete is
      // itself every turn's real terminal, so closing the window here makes the guard self-limiting and
      // removes any dependency on task_started being present. Without this, a task_started-only reset
      // stays `true` past this turn if task_started is ever absent for the next one, and SILENTLY DROPS
      // that later turn's own fallback-only reply — converting the duplicate this guard fixes into a
      // loss, which this repo's docs/decisions/88f11385 fail-toward-duplicate principle rules out.
      sawAssistantResponseThisTurn = false;
      continue;
    }
  }
  return turns;
}

export function readTranscript(cwd: string, conversationId: string): TranscriptTurn[] {
  const file = resolveTranscriptFile(cwd, conversationId);
  if (!file) return [];
  return parseTranscriptFile(file);
}

/** Best-effort copy of a conversation's rollout file into Loom's own archive store — the codex mirror of
 *  `sessions/transcript.ts#snapshotTranscript` (which is hardcoded to claude's own resolve function; see
 *  `pty/adapter.ts`'s coupling-audit table), reusing that file's generic, harness-agnostic
 *  {@link archivedTranscriptPath}. Never throws. */
export function snapshotTranscript(cwd: string, conversationId: string, projectId: string, sessionId: string): boolean {
  try {
    const src = resolveTranscriptFile(cwd, conversationId);
    if (!src) return false;
    const dest = archivedTranscriptPath(projectId, sessionId);
    try {
      const d = fs.statSync(dest);
      const s = fs.statSync(src);
      if (d.mtimeMs >= s.mtimeMs) return true; // already current — idempotent no-op
    } catch { /* no snapshot yet — fall through and create it */ }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false; // BEST-EFFORT — a snapshot failure must never disturb the exit path
  }
}
