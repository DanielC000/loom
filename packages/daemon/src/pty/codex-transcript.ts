import fs from "node:fs";
import path from "node:path";
import type { TranscriptTurn } from "./adapter.js";
import { archivedTranscriptPath } from "../sessions/transcript.js";
import { realCodexHome } from "./codex-doctrine.js";

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
 * Card 49d43ef9: `findConversationIdForSpawn`'s freshness filter compares a candidate rollout file's
 * `mtimeMs` (filesystem-reported) against `sinceMs` (a `Date.now()` wall-clock reading captured BEFORE
 * the spawn). Those two clocks are not guaranteed to agree — measured on this host, n=3000, no induced
 * load: a just-written file's `mtimeMs` read BELOW `sinceMs` in 4.37% of writes (min observed −1.97ms).
 * A strict `mtimeMs < sinceMs` therefore permanently rejects a valid, just-written rollout file a few
 * percent of the time — permanently, because mtime never changes between retries, so every subsequent
 * attempt in the retry ladder rejects the same file identically.
 *
 * ⚠️ WHY THIS IS NOT 2000ms (the first draft's value, and NOT a FAT/exFAT-granularity justification —
 * this project's target filesystems (NTFS/ext4/APFS) don't run at 2s granularity; the measured skew above
 * was sub-2ms, well inside even NTFS's ~15.6ms system-clock-tick granularity): `sessions/service.ts`'s
 * `recycleWorker` hard-stops a worker and spawns its successor into the SAME `cwd` (worktreePath, `fresh:
 * Session = { ..., cwd: worktreePath, ... }`, `worktreePath = old.worktreePath ?? old.cwd`) with NO
 * `--resume` — a genuinely fresh spawn, so `captureCodexEngineSessionId` scans again from scratch. The
 * predecessor's own rollout file (same cwd ⇒ same `session_meta.payload.cwd` match) can therefore be
 * SITTING RIGHT THERE when the successor's scan runs, and if its mtime lands within this tolerance of the
 * successor's `sinceMs`, a naive tolerance could hand the successor the PREDECESSOR's conversation id — a
 * correctness failure (silent identity adoption) far worse than the missed-capture bug this card fixes.
 * Two things bound (not eliminate) that risk here, deliberately kept SMALL to leave as little as possible
 * to the second:
 *  1. The newest-mtime tiebreak below (`best && mtimeMs <= best.mtimeMs → skip`) already prefers a
 *     strictly-fresher candidate over a stale-but-in-tolerance one whenever BOTH are present at scan time
 *     — and this file's own header states codex writes `session_meta` "well before any TUI output", while
 *     the FIRST scan only fires once the ready marker has rendered (`pty/host.ts`), so the successor's OWN
 *     rollout file should normally already exist by then. This is an empirical observation, not a code-
 *     enforced ordering guarantee across codex CLI versions — it narrows the risk, it does not close it.
 *  2. The tolerance itself is kept to the smallest value that comfortably swamps the MEASURED skew
 *     (100ms ≈ 50× the observed −1.97ms max) rather than a round, "safe-feeling" number — a wide tolerance
 *     widens the SAME window that lets the recycle race through, since this filter cannot distinguish
 *     "the true new file, mildly skewed" from "the predecessor's leftover file, genuinely stale by a
 *     similar margin." Closing the residual race fully would need an explicit exclusion (e.g. threading
 *     the predecessor's already-known engine-session id/rollout path into the scan) — that reaches into
 *     `pty/host.ts`, out of this file's scope; flagged up rather than attempted here.
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

/**
 * Locate a conversation's rollout file. Unlike Claude's per-cwd-encoded-dir + `<id>.jsonl` scheme, a
 * Codex rollout filename is `rollout-<ISO-timestamp>-<uuid>.jsonl` nested under `sessions/YYYY/MM/DD/` —
 * the `cwd` isn't part of the path at all (confirmed: `session_meta.payload.cwd` carries it INSIDE the
 * file instead), so there is no direct/computed path to try first the way Claude's `engineTranscriptPath`
 * has. Every lookup is a scan; bounded to `depth:3` (YYYY/MM/DD) and cached by conversation id so a
 * repeat lookup (e.g. a live session's own liveness re-check) doesn't re-walk the tree.
 */
export function resolveTranscriptFile(_cwd: string, conversationId: string): string | null {
  const cachedHit = resolvedPathCache.get(conversationId);
  if (cachedHit !== undefined) {
    if (fs.existsSync(cachedHit)) return cachedHit;
    resolvedPathCache.delete(conversationId);
  }
  let found: string | null = null;
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
          const hit = files.find((f) => f.endsWith(".jsonl") && f.includes(conversationId));
          if (hit) { found = path.join(dayDir, hit); break; }
        }
        if (found) break;
      }
      if (found) break;
    }
  } catch { /* sessions root missing — nothing to find */ }
  if (found !== null) rememberResolvedPath(conversationId, found);
  return found;
}

export function transcriptExists(cwd: string, conversationId: string): boolean {
  return resolveTranscriptFile(cwd, conversationId) !== null;
}

/** Read a rollout file's FIRST line only and, iff it's a `session_meta` record, return its
 *  `{session_id, cwd}` — the two fields {@link findConversationIdForSpawn} needs to match a candidate file
 *  against a spawn. Confirmed shape: `session_meta` is always the first line (this file's own header). */
function readSessionMeta(file: string): { sessionId: string; cwd: string } | null {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const nl = raw.indexOf("\n");
  const firstLine = nl === -1 ? raw : raw.slice(0, nl);
  if (!firstLine.trim()) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(firstLine); } catch { return null; }
  if (o.type !== "session_meta") return null;
  const payload = o.payload as Record<string, unknown> | undefined;
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (typeof sessionId !== "string" || typeof cwd !== "string") return null;
  return { sessionId, cwd: path.resolve(cwd) };
}

/**
 * DoD-1 (card 2ec60d9c): codex has no SessionStart-hook equivalent to REPORT its own conversation id the
 * way claude's engine does — `CodexLive.engineSessionId` (`pty/host.ts`) would stay permanently null
 * without this. Codex writes its rollout file's FIRST line (`session_meta`, carrying `session_id`+`cwd`)
 * essentially at conversation start — well before any TUI output a human/Loom would ever observe — so this
 * DISCOVERS the id instead of being told it: scan every rollout file created at/after `sinceMs` (a cheap
 * `stat`-only filter BEFORE ever reading a candidate's content) and return the `session_id` of the one
 * whose OWN `session_meta.payload.cwd` matches `cwd` — the newest such match, if more than one candidate
 * somehow qualifies (e.g. two sessions spawned into the same cwd within the same window). Unlike
 * {@link resolveTranscriptFile} (which matches an ALREADY-KNOWN id against a filename substring), this has
 * no id to match against yet — cwd + recency is the only correlator available at spawn time. Returns null
 * (never throws) when nothing matches, including a genuinely-not-yet-written file — the caller
 * (`pty/host.ts`'s `captureCodexEngineSessionId`) is responsible for any retry.
 */
export function findConversationIdForSpawn(cwd: string, sinceMs: number): string | null {
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
            // Card 49d43ef9: tolerate mtime/wall-clock skew (see MTIME_SKEW_TOLERANCE_MS's own doc) —
            // never reads a file that predates this spawn by more than that tolerance.
            if (mtimeMs < sinceMs - MTIME_SKEW_TOLERANCE_MS) continue;
            if (best && mtimeMs <= best.mtimeMs) continue; // already have a newer-or-equal match
            const meta = readSessionMeta(full);
            if (meta && meta.cwd === resolvedCwd) best = { sessionId: meta.sessionId, mtimeMs };
          }
        }
      }
    }
  } catch { /* sessions root missing — nothing to find yet */ }
  return best?.sessionId ?? null;
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

/** Parse one rollout JSONL file into ordered, harness-agnostic turns. */
export function parseTranscriptFile(file: string): TranscriptTurn[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    const payload = o.payload as Record<string, unknown> | undefined;
    if (o.type === "response_item" && payload?.type === "message") {
      const text = extractContentText(payload.content);
      if (text.trim()) turns.push({ role: classifyRole(payload.role), text });
      continue;
    }
    // Defensive fallback (UNCONFIRMED shape — see this file's header gap note): task_complete's
    // last_agent_message is the one documented-by-naming place an assistant reply could live when it
    // never appears as its own response_item.
    if (o.type === "event_msg" && payload?.type === "task_complete" && typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
      turns.push({ role: "assistant", text: payload.last_agent_message });
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
